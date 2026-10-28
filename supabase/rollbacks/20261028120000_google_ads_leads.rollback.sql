-- ROLLBACK for supabase/migrations/20261028120000_google_ads_leads.sql. Never applied automatically: this
-- folder is not supabase/migrations. Run by hand, only on the owner's explicit OK, only if the Google Ads
-- migration has to be undone.
--
-- What it restores, exactly as live on prod before the Google Ads migration (read 2026-10-28 with
-- pg_get_constraintdef / pg_get_functiondef):
--   lead_data_lead_source_check     facebook | telecaller
--   lead_data_source_fields_check   facebook branch + telecaller branch, unchanged text
--   get_dashboard_stats             the body from 20261026170000_lead_source_telecaller_leads.sql
-- and drops every object the Google Ads migration created (the cron job lives in its own migration,
-- 20261028130000_google_ads_lead_names_cron.sql; it is unscheduled here too in case it was applied).
--
-- ORDER: the app code on branch feature/google-ads-integration reads lead_data.google_lead_id and
-- google_campaign_id on the leads page. If that code is live, revert/redeploy the app WITHOUT it first, then run
-- this file. Running this while that code is live breaks the leads page for every tenant, Meta leads included.
--
-- Safety: it refuses to run while any Google Ads lead exists, because the restored checks would reject those
-- rows. Deleting customer leads is a separate decision for the owner, never part of a rollback.
--
-- Locks: ALTER TABLE lead_data takes an ACCESS EXCLUSIVE lock for the few milliseconds the catalog changes
-- need; the restored check is added NOT VALID and validated afterwards (SHARE UPDATE EXCLUSIVE, does not
-- block reads or writes), as 20261026170000 did.

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.lead_data where lead_source = 'google_ads') then
    raise exception 'Google Ads leads exist; rollback refused. Decide what to do with them first.';
  end if;
end;
$$;

-- pg_cron job (only present if 20261028130000 was applied).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'crm-google-lead-names') then
    perform cron.unschedule('crm-google-lead-names');
  end if;
end;
$$;

drop function if exists public.ingest_google_lead(uuid, uuid, text, boolean, text, text, text, text, text, text, timestamptz, jsonb, jsonb);
drop function if exists public.claim_due_google_lead_name();
drop function if exists public.complete_google_lead_name(uuid, uuid, uuid, text);
drop function if exists public.schedule_google_lead_name_retry(uuid, uuid, uuid, timestamptz, text, boolean);
drop function if exists public.recover_google_lead_names();
drop function if exists public.requeue_google_lead_names(uuid);

alter table public.lead_data drop constraint if exists lead_data_google_lead_event_fk;

alter table public.lead_data drop constraint lead_data_source_fields_check;
alter table public.lead_data add constraint lead_data_source_fields_check check (
  (lead_source = 'facebook'
    and webhook_notification_event_id is not null and leadgen_id is not null
    and facebook_page_record_id is not null and facebook_page_id is not null
    and form_id is not null and raw_lead_payload is not null)
  or
  (lead_source = 'telecaller'
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and raw_lead_payload is null and ad_id is null)
) not valid;

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller')) not valid;

drop index if exists public.lead_data_tenant_google_lead_id_key;
drop index if exists public.lead_data_google_lead_event_id_key;
drop index if exists public.lead_data_tenant_google_campaign_created_idx;

alter table public.lead_data
  drop column if exists google_lead_event_id,
  drop column if exists google_lead_id,
  drop column if exists google_campaign_id,
  drop column if exists google_adgroup_id,
  drop column if exists google_creative_id,
  drop column if exists google_asset_group_id,
  drop column if exists google_gcl_id;

drop table if exists public.google_lead_events;
drop table if exists public.google_lead_webhooks;
drop table if exists public.google_ads_entity_names;
drop table if exists public.google_ads_accounts;
drop table if exists public.google_connections;

-- get_dashboard_stats exactly as before the Google Ads migration.
create or replace function public.get_dashboard_stats(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_month_from timestamptz,
  p_month_to timestamptz,
  p_prev_month_from timestamptz,
  p_prev_month_to timestamptz,
  p_page_record_id uuid,
  p_ad_id text,
  p_status text,
  p_label text,
  p_search text,
  p_search_digits text,
  p_tz text,
  p_granularity text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_pattern text;
  v_result jsonb;
begin
  if p_tenant_id is null then
    raise exception 'tenant is required';
  end if;
  if p_granularity not in ('hour', 'day', 'month') then
    raise exception 'invalid granularity';
  end if;

  -- queryLeads matches ilike '%<raw>%' through PostgREST, which turns '*' into '%'.
  v_pattern := case when p_search is null or p_search = '' then null
                    else '%' || replace(p_search, '*', '%') || '%' end;

  with base as (
    select ld.id, ld.ad_id, ld.ad_name, ld.facebook_page_record_id, ld.lead_created_time, ld.status, ld.label, ld.lead_source
    from public.lead_data as ld
    where ld.tenant_id = p_tenant_id
      and (p_page_record_id is null or ld.facebook_page_record_id = p_page_record_id)
      and (p_ad_id is null
           or (p_ad_id = 'unattributed' and ld.ad_id is null and ld.lead_source = 'facebook')
           or (p_ad_id <> 'unattributed' and ld.ad_id = p_ad_id))
      and (p_status is null or ld.status = p_status)
      and (p_label is null or ld.label = p_label)
      and (v_pattern is null
           or ld.lead_name ilike v_pattern
           or ld.lead_email ilike v_pattern
           or ld.lead_phone ilike v_pattern
           or (p_search_digits is not null and ld.lead_phone_normalized = p_search_digits))
  ), filtered as (
    select * from base b
    where (p_from is null or b.lead_created_time >= p_from)
      and (p_to is null or b.lead_created_time < p_to)
  ), bounds as (
    -- Tenant-local naive timestamps. With a date window the timeline covers exactly that window;
    -- without one it covers the tenant's history, capped at the 24 most recent months.
    select
      case when p_from is not null and p_to is not null
           then date_trunc(p_granularity, p_from at time zone p_tz)
           else greatest(
                  date_trunc('month', coalesce((select min(f.lead_created_time) from filtered f), now()) at time zone p_tz),
                  date_trunc('month', now() at time zone p_tz) - interval '23 months')
      end as s_from,
      case when p_from is not null and p_to is not null
           then date_trunc(p_granularity, (p_to - interval '1 microsecond') at time zone p_tz)
           else date_trunc('month', now() at time zone p_tz)
      end as s_to
  ), per_ad as (
    select f.ad_id,
           (array_agg(f.ad_name order by f.lead_created_time desc) filter (where f.ad_name is not null))[1] as ad_name,
           count(*) as cnt
    from filtered f
    where f.lead_source = 'facebook'
    group by f.ad_id
  ), ranked as (
    select p.ad_id, p.ad_name, p.cnt, row_number() over (order by p.cnt desc, p.ad_id) as rn
    from per_ad p where p.ad_id is not null
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'monthToDate', (select count(*) from base b
                    where b.lead_created_time >= p_month_from and b.lead_created_time < p_month_to),
    'previousMonthSamePeriod', (select count(*) from base b
                    where b.lead_created_time >= p_prev_month_from and b.lead_created_time < p_prev_month_to),
    'byPage', coalesce((
      select jsonb_agg(jsonb_build_object('pageRecordId', x.page_id, 'pageName', x.page_name, 'count', x.cnt)
                       order by x.cnt desc, x.page_name)
      from (
        select f.facebook_page_record_id as page_id,
               case when f.lead_source = 'telecaller' then 'Telecaller'
                    else coalesce(fp.facebook_page_name, 'Unknown Page') end as page_name,
               count(*) as cnt
        from filtered f
        left join public.facebook_pages fp
          on fp.id = f.facebook_page_record_id and fp.tenant_id = p_tenant_id
        group by f.lead_source, f.facebook_page_record_id, fp.facebook_page_name
      ) x
    ), '[]'::jsonb),
    'byLabel', (
      select jsonb_agg(jsonb_build_object('label', l.label, 'count', l.cnt) order by l.ord)
      from (
        select v.label, v.ord, count(f.id) as cnt
        from (values ('Hot', 1), ('Warm', 2), ('Cold', 3), ('Not Interested', 4)) as v(label, ord)
        left join filtered f on f.label = v.label
        group by v.label, v.ord
      ) l
    ),
    'byStatus', (
      select jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt) order by s.ord)
      from (
        select v.status, v.ord, count(f.id) as cnt
        from (values
          ('New Lead', 1), ('Not reachable', 2), ('Working', 3), ('Closed', 4), ('Archived', 5),
          ('Sale', 6), ('Site visit done', 7), ('Next project', 8), ('Site visit pending', 9),
          ('Final call', 10), ('Didn''t pick the call', 11), ('Details send via WhatsApp', 12),
          ('Disqualified', 13), ('Asking Time for Taking Decision', 14)
        ) as v(status, ord)
        left join filtered f on f.status = v.status
        group by v.status, v.ord
      ) s
    ),
    'topAds', coalesce((
      select jsonb_agg(u.item order by u.sort_key) from (
        select jsonb_build_object('adId', r.ad_id, 'name', r.ad_name, 'count', r.cnt) as item, r.rn as sort_key
        from ranked r where r.rn <= 8
        union all
        select jsonb_build_object('adId', 'other', 'name', 'Other', 'count', sum(r.cnt)), 9::bigint
        from ranked r where r.rn > 8 having count(*) > 0
        union all
        select jsonb_build_object('adId', 'unattributed', 'name', 'Unattributed', 'count', p.cnt), 10::bigint
        from per_ad p where p.ad_id is null
        union all
        select jsonb_build_object('adId', 'telecaller', 'name', 'Telecaller', 'count', count(*)), 11::bigint
        from filtered f where f.lead_source = 'telecaller' having count(*) > 0
      ) u
    ), '[]'::jsonb),
    'timeline', coalesce((
      select jsonb_agg(jsonb_build_object(
               'bucket', to_char(g.bucket, 'YYYY-MM-DD"T"HH24:MI:SS'), 'count', coalesce(c.cnt, 0))
             order by g.bucket)
      from bounds bd
      cross join lateral generate_series(bd.s_from, bd.s_to, ('1 ' || p_granularity)::interval) as g(bucket)
      left join (
        select date_trunc(p_granularity, f.lead_created_time at time zone p_tz) as bucket, count(*) as cnt
        from filtered f
        group by 1
      ) c on c.bucket = g.bucket
    ), '[]'::jsonb),
    'timelineTruncated', exists (
      select 1 from filtered f, bounds bd
      where date_trunc(p_granularity, f.lead_created_time at time zone p_tz) < bd.s_from
    ),
    'generatedAt', now()
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_dashboard_stats(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.get_dashboard_stats(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, text, text) to service_role;

commit;

-- Outside the transaction: validate the two restored checks (reads every row, does not block writes).
alter table public.lead_data validate constraint lead_data_source_fields_check;
alter table public.lead_data validate constraint lead_data_lead_source_check;
