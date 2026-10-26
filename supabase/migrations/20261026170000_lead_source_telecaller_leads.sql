-- Call-in (telecaller) leads: a lead a member adds by hand after a phone call, next to the Meta Lead Ads leads.
--
-- 1. lead_data.lead_source         — 'facebook' (every Meta lead; the DEFAULT, so the Meta insert in
--                                     complete_meta_lead_retrieval_event fills it without being changed) or
--                                     'telecaller'. Every existing row becomes 'facebook'.
-- 2. The 6 Facebook-only columns     — no longer NOT NULL, but lead_data_source_fields_check keeps them required
--                                     for every 'facebook' row, exactly as before; a 'telecaller' row must leave
--                                     them (and ad_id) empty.
-- 3. create_telecaller_lead          — the only writer of telecaller leads. Service-role RPC, pinned to the tenant
--                                     and actor the Next API route verified; re-checks the actor is an active member.
-- 4. get_dashboard_stats             — call-in leads get their own "Telecaller" page/ad bucket instead of being
--                                     counted as "Unknown Page" / "Unattributed".

begin;

-- ---------------------------------------------------------------------------
-- lead_source
-- ---------------------------------------------------------------------------
alter table public.lead_data
  add column lead_source text not null default 'facebook'
    constraint lead_data_lead_source_check check (lead_source in ('facebook', 'telecaller'));

alter table public.lead_data
  alter column webhook_notification_event_id drop not null,
  alter column leadgen_id drop not null,
  alter column facebook_page_record_id drop not null,
  alter column facebook_page_id drop not null,
  alter column form_id drop not null,
  alter column raw_lead_payload drop not null;

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
alter table public.lead_data validate constraint lead_data_source_fields_check;

create index lead_data_tenant_source_created_idx
  on public.lead_data (tenant_id, lead_source, lead_created_time desc);

-- ---------------------------------------------------------------------------
-- create_telecaller_lead
-- ---------------------------------------------------------------------------
-- Name and phone are stored in field_data under the same keys Meta uses (full_name, phone_number), so the
-- existing populate_meta_lead_contact_fields trigger fills lead_name / lead_phone / lead_phone_normalized and
-- search, tasks, reminders and push all read them unchanged. WhatsApp and project show in the drawer's
-- "Form answers" card.
--
-- No AI label: label_source = 'telecaller'. The lead_label_classifications row is written here as 'completed'
-- (next_retry_at NULL, as terminal_schedule_check requires), so the classifier and its requeue sweep skip it.
--
-- Duplicate phone (same tenant, any source) raises P0001 LEAD_PHONE_EXISTS. The transaction-scoped advisory lock
-- on (tenant, normalized phone) makes two members adding the same number at the same moment queue up, so the
-- second one sees the first one's row.
--
-- The lead is inserted unassigned and then assigned to the actor with app.current_user_id set, so the existing
-- log_lead_assignment trigger records "Assigned to <name>" by that person.
create or replace function public.create_telecaller_lead(
  p_tenant_id uuid, p_actor_user_id uuid, p_lead_name text, p_phone text, p_whatsapp text, p_project_name text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text := pg_catalog.btrim(coalesce(p_lead_name, ''));
  v_phone text := pg_catalog.btrim(coalesce(p_phone, ''));
  v_whatsapp text := nullif(pg_catalog.btrim(coalesce(p_whatsapp, '')), '');
  v_project text := pg_catalog.btrim(coalesce(p_project_name, ''));
  v_fields jsonb;
  v_normalized text;
  v_lead_id uuid;
begin
  perform public.assert_active_tenant_member(p_tenant_id, p_actor_user_id);

  if pg_catalog.length(v_name) not between 1 and 200 then
    raise exception 'Lead name is required (max 200 characters)' using errcode = '22023';
  end if;
  if pg_catalog.length(v_project) not between 1 and 200 then
    raise exception 'Project name is required (max 200 characters)' using errcode = '22023';
  end if;
  if pg_catalog.length(v_phone) > 30 or pg_catalog.length(pg_catalog.regexp_replace(v_phone, '[^0-9]', '', 'g')) < 10 then
    raise exception 'Enter a valid phone number' using errcode = '22023';
  end if;
  if v_whatsapp is not null and (pg_catalog.length(v_whatsapp) > 30
      or pg_catalog.length(pg_catalog.regexp_replace(v_whatsapp, '[^0-9]', '', 'g')) < 10) then
    raise exception 'Enter a valid WhatsApp number' using errcode = '22023';
  end if;

  v_fields := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('name', 'full_name', 'values', pg_catalog.jsonb_build_array(v_name)),
      pg_catalog.jsonb_build_object('name', 'phone_number', 'values', pg_catalog.jsonb_build_array(v_phone)))
    || case when v_whatsapp is null then '[]'::jsonb else pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('name', 'whatsapp_number', 'values', pg_catalog.jsonb_build_array(v_whatsapp))) end
    || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('name', 'project_name', 'values', pg_catalog.jsonb_build_array(v_project)));

  select contact.lead_phone_normalized into v_normalized
  from public.extract_meta_lead_contact_fields(v_fields) as contact;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':' || v_normalized, 0));
  if exists (
    select 1 from public.lead_data as ld
    where ld.tenant_id = p_tenant_id and ld.lead_phone_normalized = v_normalized
  ) then
    raise exception 'LEAD_PHONE_EXISTS' using errcode = 'P0001';
  end if;

  insert into public.lead_data (tenant_id, lead_source, label_source, lead_created_time, field_data)
  values (p_tenant_id, 'telecaller', 'telecaller', pg_catalog.clock_timestamp(), v_fields)
  returning id into v_lead_id;

  insert into public.lead_label_classifications (tenant_id, lead_id, final_label, label_source, status, next_retry_at)
  select ld.tenant_id, ld.id, ld.label, 'telecaller', 'completed', null
  from public.lead_data as ld
  where ld.tenant_id = p_tenant_id and ld.id = v_lead_id
  on conflict (lead_id) do nothing;

  perform pg_catalog.set_config('app.current_user_id', p_actor_user_id::text, true);
  update public.lead_data as ld
  set assigned_user_id = p_actor_user_id
  where ld.tenant_id = p_tenant_id and ld.id = v_lead_id;
  perform pg_catalog.set_config('app.current_user_id', '', true);

  return v_lead_id;
end;
$$;

revoke all on function public.create_telecaller_lead(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_telecaller_lead(uuid, uuid, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- get_dashboard_stats: same signature and body as 20261015130000_lead_status_asking_time_for_decision.sql,
-- with call-in leads shown as "Telecaller" in byPage and topAds, and the 'unattributed' ad filter/bucket
-- limited to Facebook leads (matching queryLeads in src/lib/server/lead-query-service.ts).
-- ---------------------------------------------------------------------------
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
