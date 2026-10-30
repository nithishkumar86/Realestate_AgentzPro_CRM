-- Call-in leads: "Came from" (which lead platform, and which ad or campaign) and the real call date.
--
-- A lead a member adds with the "+" button stays lead_source = 'telecaller' (how it entered the CRM: typed in by a
-- telecaller). Where the person came from is a separate fact, stored in new columns, so a call-in lead from a
-- Facebook ad shows under Facebook AND under Telecaller. The Meta and Google writers are not changed: they never
-- write the new columns, and the derived columns below follow lead_source for their rows.
--
-- 1. lead_data.came_from_platform / came_from_ref_id / came_from_ref_name
--      Set only on telecaller rows, only by create_call_in_lead. The ad / campaign name is copied from this tenant's
--      own ad tables when the lead is saved, never taken from the request. ad_id stays NULL for call-in leads, so the
--      ad assignment rule, the Meta ad-name resolver and lead_data_source_fields_check never see them.
-- 2. lead_data.lead_platform (generated)  the platform the lead belongs to: lead_source for Meta / Google rows,
--                                          came_from_platform for call-in rows (NULL when none was picked).
--    lead_data.lead_ad_ref (generated)    the Meta ad id or Google campaign id the lead belongs to: ad_id for Meta
--                                          rows (Google rows keep their own google_* columns), the picked ref for
--                                          call-in rows. The /leads Ad filter and the dashboard use it scoped to
--                                          lead_platform = 'facebook', so a Meta ad id never matches a Google id.
-- 3. The platform registry for call-in leads, in one place: call_in_platforms() lists them, and
--    call_in_platform_connected() / call_in_platform_ref_name() say, per platform, whether the company is connected
--    right now and which of its ads or campaigns a lead can be credited to. list_call_in_origins (the "+" form) and
--    create_call_in_lead (the save) both read them, so the form and the save can never disagree.
--    Adding a platform: allow it in lead_data_lead_source_check and lead_data_came_from_check, add it to
--    call_in_platforms(), and add one branch to each of the two helpers and to list_call_in_origins' refs.
-- 4. create_call_in_lead      next to create_telecaller_lead (expand). The live app keeps calling the old function
--                             until the new app is deployed; a later migration drops it (contract), on a separate OK.
-- 5. get_dashboard_platform_stats  same signature, body extended: a call-in lead credited to a platform also counts
--                             in that platform's view (Facebook: "Added by telecaller" page bucket and the picked ad;
--                             Google Ads: the picked campaign). Until create_call_in_lead is used no row has
--                             came_from_platform, so every result is identical to the live function's.
--
-- Locks: adding the two STORED generated columns rewrites lead_data under ACCESS EXCLUSIVE (17 rows on prod at
-- 2026-10-30, so milliseconds). lock_timeout makes it fail and roll back cleanly instead of queueing every lead
-- read/write behind a long query.
-- Undo: supabase/rollbacks/20261030120000_call_in_lead_came_from.rollback.sql.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.lead_data
  add column came_from_platform text,
  add column came_from_ref_id text,
  add column came_from_ref_name text;

alter table public.lead_data add constraint lead_data_came_from_check check (
  (came_from_platform is null and came_from_ref_id is null and came_from_ref_name is null)
  or
  (lead_source = 'telecaller'
    and came_from_platform in ('facebook', 'google_ads')
    and (came_from_ref_id is null) = (came_from_ref_name is null))
) not valid;
alter table public.lead_data validate constraint lead_data_came_from_check;

alter table public.lead_data
  add column lead_platform text generated always as
    (case when lead_source = 'telecaller' then came_from_platform else lead_source end) stored,
  add column lead_ad_ref text generated always as (coalesce(ad_id, came_from_ref_id)) stored;

create index lead_data_tenant_platform_created_idx
  on public.lead_data (tenant_id, lead_platform, lead_created_time desc)
  where lead_platform is not null;

-- ---------------------------------------------------------------------------
-- Platform registry for call-in leads
-- ---------------------------------------------------------------------------
-- In LEAD_SOURCES order (src/features/leads/lead-options.ts), Telecaller left out: it is how a call-in lead
-- entered, never where the person came from.
create function public.call_in_platforms()
returns text[] language sql immutable set search_path = '' as $$
  select array['facebook', 'google_ads']::text[]
$$;

-- Connected right now: Facebook = a Page that is not disconnected (a Page waiting for re-authorisation is still
-- connected); Google Ads = the active lead webhook, the only way Google leads arrive.
create function public.call_in_platform_connected(p_tenant_id uuid, p_platform text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_platform
    when 'facebook' then exists (
      select 1 from public.facebook_pages as fp
      where fp.tenant_id = p_tenant_id and fp.connection_status <> 'disconnected')
    when 'google_ads' then exists (
      select 1 from public.google_lead_webhooks as w
      where w.tenant_id = p_tenant_id and w.is_active)
    else false
  end
$$;

-- The name of one of this tenant's ads (Meta) or campaigns (Google) a lead can be credited to; NULL when the
-- tenant has no such named ad. Only named ones can be picked, so the leads table always has a name to show, and a
-- Meta ad whose Page was disconnected is left out (call_in_meta_ad_offered).
create function public.call_in_meta_ad_offered(p_tenant_id uuid, p_source_page_record_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_source_page_record_id is null or exists (
    select 1 from public.facebook_pages as fp
    where fp.tenant_id = p_tenant_id and fp.id = p_source_page_record_id and fp.connection_status <> 'disconnected')
$$;

create function public.call_in_platform_ref_name(p_tenant_id uuid, p_platform text, p_ref_id text)
returns text language sql stable security definer set search_path = '' as $$
  select case p_platform
    when 'facebook' then (
      select nullif(pg_catalog.btrim(ma.ad_name), '') from public.meta_ads as ma
      where ma.tenant_id = p_tenant_id and ma.ad_id = p_ref_id
        and public.call_in_meta_ad_offered(p_tenant_id, ma.source_facebook_page_record_id))
    when 'google_ads' then (
      select nullif(pg_catalog.btrim(gn.name), '') from public.google_ads_entity_names as gn
      where gn.tenant_id = p_tenant_id and gn.entity_type = 'campaign' and gn.entity_id = p_ref_id)
  end
$$;

-- ---------------------------------------------------------------------------
-- list_call_in_origins: what the "+" form offers. Only the platforms connected right now, each with its named ads
-- or campaigns, plus the call-date range in the tenant's timezone.
-- ---------------------------------------------------------------------------
create function public.list_call_in_origins(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_today date;
begin
  select t.timezone into v_tz from public.tenants as t where t.tenant_id = p_tenant_id;
  if v_tz is null then
    raise exception 'Tenant timezone is required' using errcode = '22023';
  end if;
  v_today := (pg_catalog.clock_timestamp() at time zone v_tz)::date;

  return pg_catalog.jsonb_build_object(
    'today', v_today,
    'minDate', v_today - 365,
    'platforms', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.platform, 'refs', (
        case p.platform
          when 'facebook' then coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', ma.ad_id, 'name', pg_catalog.btrim(ma.ad_name))
                                        order by pg_catalog.btrim(ma.ad_name), ma.ad_id)
            from public.meta_ads as ma
            where ma.tenant_id = p_tenant_id and nullif(pg_catalog.btrim(ma.ad_name), '') is not null
              and public.call_in_meta_ad_offered(p_tenant_id, ma.source_facebook_page_record_id)), '[]'::jsonb)
          when 'google_ads' then coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', gn.entity_id, 'name', pg_catalog.btrim(gn.name))
                                        order by pg_catalog.btrim(gn.name), gn.entity_id)
            from public.google_ads_entity_names as gn
            where gn.tenant_id = p_tenant_id and gn.entity_type = 'campaign'
              and nullif(pg_catalog.btrim(gn.name), '') is not null), '[]'::jsonb)
          else '[]'::jsonb
        end)) order by p.ord)
      from pg_catalog.unnest(public.call_in_platforms()) with ordinality as p(platform, ord)
      where public.call_in_platform_connected(p_tenant_id, p.platform)
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- create_call_in_lead: create_telecaller_lead (20261026170000_lead_source_telecaller_leads.sql) unchanged, plus:
--   * p_came_from_platform  required when the company has any platform connected right now (the form always has
--                           one chosen then); must itself be connected right now.
--   * p_came_from_ref_id    optional; one of this tenant's named ads / campaigns on that platform. Its name is
--                           copied from that table.
--   * p_call_date           optional (NULL = today), in the tenant's timezone, from 365 days ago to today. Today keeps
--                           the moment of saving; an earlier day is stored at 12:00 that day. created_at still records
--                           when the lead was saved.
-- A platform or ad that went away while the form was open raises P0001 CALL_IN_ORIGIN_CHANGED, so the form reloads.
-- ---------------------------------------------------------------------------
create function public.create_call_in_lead(
  p_tenant_id uuid, p_actor_user_id uuid, p_lead_name text, p_phone text, p_whatsapp text, p_project_name text,
  p_came_from_platform text, p_came_from_ref_id text, p_call_date date
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text := pg_catalog.btrim(coalesce(p_lead_name, ''));
  v_phone text := pg_catalog.btrim(coalesce(p_phone, ''));
  v_whatsapp text := nullif(pg_catalog.btrim(coalesce(p_whatsapp, '')), '');
  v_project text := pg_catalog.btrim(coalesce(p_project_name, ''));
  v_platform text := nullif(pg_catalog.btrim(coalesce(p_came_from_platform, '')), '');
  v_ref_id text := nullif(pg_catalog.btrim(coalesce(p_came_from_ref_id, '')), '');
  v_ref_name text;
  v_tz text;
  v_today date;
  v_created_time timestamptz;
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

  -- Came from
  if v_platform is null then
    if v_ref_id is not null then
      raise exception 'CALL_IN_ORIGIN_CHANGED' using errcode = 'P0001';
    end if;
    if exists (select 1 from pg_catalog.unnest(public.call_in_platforms()) as p(platform)
               where public.call_in_platform_connected(p_tenant_id, p.platform)) then
      raise exception 'CALL_IN_ORIGIN_CHANGED' using errcode = 'P0001';
    end if;
  else
    if not (v_platform = any (public.call_in_platforms()))
       or not public.call_in_platform_connected(p_tenant_id, v_platform) then
      raise exception 'CALL_IN_ORIGIN_CHANGED' using errcode = 'P0001';
    end if;
    if v_ref_id is not null then
      v_ref_name := public.call_in_platform_ref_name(p_tenant_id, v_platform, v_ref_id);
      if v_ref_name is null then
        raise exception 'CALL_IN_ORIGIN_CHANGED' using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- Call date
  select t.timezone into v_tz from public.tenants as t where t.tenant_id = p_tenant_id;
  if v_tz is null then
    raise exception 'Tenant timezone is required' using errcode = '22023';
  end if;
  v_today := (pg_catalog.clock_timestamp() at time zone v_tz)::date;
  if p_call_date is null or p_call_date = v_today then
    v_created_time := pg_catalog.clock_timestamp();
  elsif p_call_date > v_today or p_call_date < v_today - 365 then
    raise exception 'Pick a call date from the last 365 days' using errcode = '22023';
  else
    v_created_time := (p_call_date + time '12:00') at time zone v_tz;
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

  insert into public.lead_data (tenant_id, lead_source, label_source, lead_created_time, field_data,
                                came_from_platform, came_from_ref_id, came_from_ref_name)
  values (p_tenant_id, 'telecaller', 'telecaller', v_created_time, v_fields, v_platform, v_ref_id, v_ref_name)
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

revoke all on function public.call_in_platforms() from public, anon, authenticated;
revoke all on function public.call_in_platform_connected(uuid, text) from public, anon, authenticated;
revoke all on function public.call_in_meta_ad_offered(uuid, uuid) from public, anon, authenticated;
revoke all on function public.call_in_platform_ref_name(uuid, text, text) from public, anon, authenticated;
revoke all on function public.list_call_in_origins(uuid) from public, anon, authenticated;
revoke all on function public.create_call_in_lead(uuid, uuid, text, text, text, text, text, text, date) from public, anon, authenticated;
grant execute on function public.call_in_platforms() to service_role;
grant execute on function public.call_in_platform_connected(uuid, text) to service_role;
grant execute on function public.call_in_meta_ad_offered(uuid, uuid) to service_role;
grant execute on function public.call_in_platform_ref_name(uuid, text, text) to service_role;
grant execute on function public.list_call_in_origins(uuid) to service_role;
grant execute on function public.create_call_in_lead(uuid, uuid, text, text, text, text, text, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- get_dashboard_platform_stats: the live body (20261029120000_dashboard_platform_stats.sql) with:
--   * base: a platform view takes every lead that belongs to it (lead_platform), so call-in leads credited to it
--     are included; the Telecaller view still takes every call-in lead (lead_source).
--   * the Ad filter and 'unattributed' use lead_ad_ref, scoped to Facebook.
--   * Facebook: call-in leads form one "Added by telecaller" Page bucket and count under the ad that was picked.
--   * Google Ads: call-in leads count under the campaign that was picked (they have no ad group).
-- ---------------------------------------------------------------------------
create or replace function public.get_dashboard_platform_stats(
  p_tenant_id uuid,
  p_lead_source text,
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
  v_result jsonb;
begin
  if p_tenant_id is null then
    raise exception 'tenant is required';
  end if;
  if p_lead_source is null or p_lead_source = '' then
    raise exception 'lead source is required';
  end if;
  if p_granularity not in ('hour', 'day', 'month') then
    raise exception 'invalid granularity';
  end if;

  with base as (
    select ld.id, ld.ad_id, ld.ad_name, ld.facebook_page_record_id, ld.lead_created_time, ld.status, ld.label,
           ld.google_campaign_id, ld.google_adgroup_id, ld.google_asset_group_id,
           ld.lead_source, ld.lead_ad_ref, ld.came_from_ref_name
    from public.lead_data as ld
    where ld.tenant_id = p_tenant_id
      and (case when p_lead_source = 'telecaller' then ld.lead_source = 'telecaller'
                else ld.lead_platform = p_lead_source end)
      and (p_page_record_id is null or ld.facebook_page_record_id = p_page_record_id)
      and (p_ad_id is null
           or (p_ad_id = 'unattributed' and ld.lead_ad_ref is null and ld.lead_platform = 'facebook')
           or (p_ad_id <> 'unattributed' and ld.lead_ad_ref = p_ad_id and ld.lead_platform = 'facebook'))
      and (p_status is null or ld.status = p_status)
      and (p_label is null or ld.label = p_label)
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
  ), group_rows as (
    -- One row per lead: which group (Page / campaign) it belongs to. Sources without groups produce no rows.
    select
      case p_lead_source
        when 'facebook' then case when f.lead_source = 'telecaller' then 'telecaller'
                                  else f.facebook_page_record_id::text end
        when 'google_ads' then coalesce(f.google_campaign_id, f.lead_ad_ref)
      end as group_id,
      case p_lead_source
        when 'facebook' then case when f.lead_source = 'telecaller' then 'Added by telecaller'
                                  else coalesce(fp.facebook_page_name, 'Unknown Page') end
        when 'google_ads' then case when coalesce(f.google_campaign_id, f.lead_ad_ref) is null then 'Unattributed'
                                    else coalesce(cn.name, f.came_from_ref_name,
                                                  'Campaign ' || coalesce(f.google_campaign_id, f.lead_ad_ref)) end
      end as group_name
    from filtered f
    left join public.facebook_pages fp
      on p_lead_source = 'facebook' and fp.id = f.facebook_page_record_id and fp.tenant_id = p_tenant_id
    left join public.google_ads_entity_names cn
      on p_lead_source = 'google_ads' and cn.tenant_id = p_tenant_id
     and cn.entity_type = 'campaign' and cn.entity_id = coalesce(f.google_campaign_id, f.lead_ad_ref)
    where p_lead_source in ('facebook', 'google_ads')
  ), item_rows as (
    -- One row per lead: which item (ad / ad group / asset group) it belongs to. A NULL item_id is "Unattributed".
    -- Asset group ids are prefixed so they can never collide with an ad group id.
    select
      case p_lead_source
        when 'facebook' then f.lead_ad_ref
        when 'google_ads' then coalesce(f.google_adgroup_id, 'asset_group:' || f.google_asset_group_id)
      end as item_id,
      case p_lead_source
        when 'facebook' then coalesce(f.ad_name, f.came_from_ref_name)
        when 'google_ads' then coalesce(gn.name,
          case when f.google_adgroup_id is not null then 'Ad group ' || f.google_adgroup_id
               when f.google_asset_group_id is not null then 'Asset group ' || f.google_asset_group_id end)
      end as item_name,
      f.lead_created_time
    from filtered f
    left join public.google_ads_entity_names gn
      on p_lead_source = 'google_ads' and gn.tenant_id = p_tenant_id
     and gn.entity_type = case when f.google_adgroup_id is not null then 'ad_group' else 'asset_group' end
     and gn.entity_id = coalesce(f.google_adgroup_id, f.google_asset_group_id)
    where p_lead_source in ('facebook', 'google_ads')
  ), per_item as (
    select i.item_id,
           (array_agg(i.item_name order by i.lead_created_time desc) filter (where i.item_name is not null))[1] as item_name,
           count(*) as cnt
    from item_rows i
    group by i.item_id
  ), ranked as (
    select p.item_id, p.item_name, p.cnt, row_number() over (order by p.cnt desc, p.item_id) as rn
    from per_item p where p.item_id is not null
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'monthToDate', (select count(*) from base b
                    where b.lead_created_time >= p_month_from and b.lead_created_time < p_month_to),
    'previousMonthSamePeriod', (select count(*) from base b
                    where b.lead_created_time >= p_prev_month_from and b.lead_created_time < p_prev_month_to),
    'byGroup', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.group_id, 'name', x.group_name, 'count', x.cnt)
                       order by x.cnt desc, x.group_name)
      from (
        select g.group_id, g.group_name, count(*) as cnt
        from group_rows g
        group by g.group_id, g.group_name
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
    'topItems', coalesce((
      select jsonb_agg(u.item order by u.sort_key) from (
        select jsonb_build_object('id', r.item_id, 'name', r.item_name, 'count', r.cnt) as item, r.rn as sort_key
        from ranked r where r.rn <= 8
        union all
        select jsonb_build_object('id', 'other', 'name', 'Other', 'count', sum(r.cnt)), 9::bigint
        from ranked r where r.rn > 8 having count(*) > 0
        union all
        select jsonb_build_object('id', 'unattributed', 'name', 'Unattributed', 'count', p.cnt), 10::bigint
        from per_item p where p.item_id is null
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

revoke all on function public.get_dashboard_platform_stats(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.get_dashboard_platform_stats(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
