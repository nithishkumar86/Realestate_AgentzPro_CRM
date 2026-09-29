-- Dashboard analytics + live-update signal.
--
-- 1. public.get_dashboard_stats(): one tenant-scoped, index-friendly aggregate for every dashboard
--    chart. Its filter predicates mirror src/lib/server/lead-query-service.ts (queryLeads) so a
--    dashboard total always equals the /leads row count for the same filters. Callable by
--    service_role only; every read is pinned to p_tenant_id.
-- 2. Statement-level triggers on lead_data that emit ONE PII-free Realtime broadcast per tenant per
--    statement on the private topic "dashboard:<tenant_id>". No policy on realtime.messages exists
--    for anon/authenticated, so a browser can never subscribe; only the server (service_role)
--    relays the ping to the tenant's own SSE streams. Every trigger body swallows errors so a
--    Realtime problem can never fail or roll back lead ingestion.

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
    select ld.id, ld.ad_id, ld.ad_name, ld.facebook_page_record_id, ld.lead_created_time, ld.status, ld.label
    from public.lead_data as ld
    where ld.tenant_id = p_tenant_id
      and (p_page_record_id is null or ld.facebook_page_record_id = p_page_record_id)
      and (p_ad_id is null
           or (p_ad_id = 'unattributed' and ld.ad_id is null)
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
               coalesce(fp.facebook_page_name, 'Unknown Page') as page_name,
               count(*) as cnt
        from filtered f
        left join public.facebook_pages fp
          on fp.id = f.facebook_page_record_id and fp.tenant_id = p_tenant_id
        group by f.facebook_page_record_id, fp.facebook_page_name
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
          ('Disqualified', 13)
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

-- ---------------------------------------------------------------------------------------------
-- Live signal. One function per operation because a transition table only exists for the
-- operation that declared it, and the error swallow below would otherwise hide a mistake.
-- ---------------------------------------------------------------------------------------------

create or replace function public.notify_lead_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  begin
    for v_tenant in select distinct tenant_id from new_rows loop
      perform realtime.send(jsonb_build_object('t', now()), 'lead_change', 'dashboard:' || v_tenant::text, true);
    end loop;
  exception when others then
    null; -- never let the live signal fail lead ingestion
  end;
  return null;
end;
$$;

create or replace function public.notify_lead_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  begin
    for v_tenant in select distinct tenant_id from new_rows loop
      perform realtime.send(jsonb_build_object('t', now()), 'lead_change', 'dashboard:' || v_tenant::text, true);
    end loop;
  exception when others then
    null;
  end;
  return null;
end;
$$;

create or replace function public.notify_lead_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  begin
    for v_tenant in select distinct tenant_id from old_rows loop
      perform realtime.send(jsonb_build_object('t', now()), 'lead_change', 'dashboard:' || v_tenant::text, true);
    end loop;
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke all on function public.notify_lead_insert() from public, anon, authenticated;
revoke all on function public.notify_lead_update() from public, anon, authenticated;
revoke all on function public.notify_lead_delete() from public, anon, authenticated;

drop trigger if exists lead_data_notify_insert on public.lead_data;
create trigger lead_data_notify_insert after insert on public.lead_data
  referencing new table as new_rows
  for each statement execute function public.notify_lead_insert();

drop trigger if exists lead_data_notify_update on public.lead_data;
create trigger lead_data_notify_update after update on public.lead_data
  referencing new table as new_rows
  for each statement execute function public.notify_lead_update();

drop trigger if exists lead_data_notify_delete on public.lead_data;
create trigger lead_data_notify_delete after delete on public.lead_data
  referencing old table as old_rows
  for each statement execute function public.notify_lead_delete();
