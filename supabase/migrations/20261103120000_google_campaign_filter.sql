-- Google Ads Campaign filter for /leads and /dashboard. Add-only: nothing that exists is changed or dropped.
--
-- A lead belongs to Google Ads campaign X when lead_platform = 'google_ads' and
-- coalesce(google_campaign_id, lead_ad_ref) = X: google_campaign_id for a lead Google sent, lead_ad_ref (the picked
-- "Came from" campaign) for a call-in lead credited to Google Ads. This is the rule the dashboard's "Leads by campaign"
-- chart already uses (group_rows in get_dashboard_platform_stats), so the table, the CSV and the dashboard agree.
-- 'unattributed' = a Google Ads lead with neither. The two columns never collide: a Google row has no ad_id (so no
-- lead_ad_ref) and a call-in row has no google_campaign_id (lead_data_source_fields_check).
--
-- 1. get_dashboard_platform_stats_v2  the live get_dashboard_platform_stats body (20261030120000_call_in_lead_came_from.sql)
--                                     plus p_campaign_id, applied in `base` like the Page and Ad filters. A new name,
--                                     not an overload, so PostgREST can never resolve a call to the wrong function.
--                                     The live app keeps calling the old function until the new app is deployed; a
--                                     later migration drops it (contract), on a separate OK.
-- 2. list_google_lead_campaigns       the Campaign filter's choices: every campaign this tenant's Google Ads leads belong
--                                     to, named like the dashboard names them, plus whether any lead is unattributed.
--
-- Both are read-only (stable), tenant-scoped by argument, and callable by service_role only.
-- Undo: supabase/rollbacks/20261103120000_google_campaign_filter.rollback.sql.

begin;

create function public.get_dashboard_platform_stats_v2(
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
  p_granularity text,
  p_campaign_id text
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
      and (p_campaign_id is null
           or (p_campaign_id = 'unattributed' and ld.lead_platform = 'google_ads'
               and ld.google_campaign_id is null and ld.lead_ad_ref is null)
           or (p_campaign_id <> 'unattributed' and ld.lead_platform = 'google_ads'
               and coalesce(ld.google_campaign_id, ld.lead_ad_ref) = p_campaign_id))
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

-- The Campaign filter's choices. One entry per campaign id, named from the tenant's Google Ads names table, else the
-- newest call-in lead's copied name, else "Campaign <id>" (the dashboard's naming order). Sorted by name.
create function public.list_google_lead_campaigns(p_tenant_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with refs as (
    select coalesce(ld.google_campaign_id, ld.lead_ad_ref) as campaign_id, ld.came_from_ref_name, ld.lead_created_time
    from public.lead_data as ld
    where ld.tenant_id = p_tenant_id and ld.lead_platform = 'google_ads'
  ), named as (
    select r.campaign_id,
           coalesce(nullif(btrim(cn.name), ''),
                    (array_agg(r.came_from_ref_name order by r.lead_created_time desc)
                       filter (where r.came_from_ref_name is not null))[1],
                    'Campaign ' || r.campaign_id) as name
    from refs r
    left join public.google_ads_entity_names cn
      on cn.tenant_id = p_tenant_id and cn.entity_type = 'campaign' and cn.entity_id = r.campaign_id
    where r.campaign_id is not null
    group by r.campaign_id, cn.name
  )
  select jsonb_build_object(
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object('id', n.campaign_id, 'name', n.name)
                                            order by lower(n.name), n.campaign_id) from named n), '[]'::jsonb),
    'hasUnattributed', exists (select 1 from refs r where r.campaign_id is null)
  )
$$;

revoke all on function public.get_dashboard_platform_stats_v2(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.get_dashboard_platform_stats_v2(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, text) to service_role;
revoke all on function public.list_google_lead_campaigns(uuid) from public, anon, authenticated;
grant execute on function public.list_google_lead_campaigns(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
