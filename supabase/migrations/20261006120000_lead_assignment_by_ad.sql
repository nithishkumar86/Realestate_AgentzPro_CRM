-- Lead assignment by ad: the owner picks ONE team member per ad, and every new lead from that ad is
-- assigned to that person automatically. A lead can also be (re)assigned by hand, and the owner can apply an
-- ad's rule to the leads of that ad that are still unassigned.
--
-- 1. lead_data.assigned_user_id       — who owns the lead. NULL = Unassigned. The composite FK keeps the assignee a
--                                       member of the SAME tenant; removing the membership only clears this one
--                                       column (ON DELETE SET NULL (col), Postgres 15+).
-- 2. lead_ad_assignment_rules         — (tenant, ad) -> assignee. Separate from meta_ads, which is the ad-name
--                                       resolver queue (claim/lease columns). Deleting the ad or the member removes
--                                       the rule. Never touched by the browser: writes go through the RPCs below.
-- 3. assign_lead_from_ad_rule         — BEFORE INSERT trigger on lead_data, so every insert path is covered
--                                       atomically. The assignee must be ACTIVE: a blocked member is skipped and the
--                                       lead stays Unassigned. Leads without an ad, or from an ad without a rule,
--                                       stay Unassigned.
-- 4. lead_assigned timeline row       — written by trigger in the same transaction as the change. Automatic
--                                       assignment and the clean-up after a member is removed log as System; a
--                                       person's action logs that person (app.current_user_id, the same pattern as
--                                       update_lead_status in 20261005120000_lead_notes_tasks_timeline.sql).
--
-- Access model matches lead_data: RLS enabled and forced, nothing granted to anon/authenticated; Next API routes
-- call the service-role RPCs, pinned to the tenant from the verified session. Every RPC re-checks the actor's
-- membership, so a wrong id can never be attributed or reach another tenant.

begin;

-- ---------------------------------------------------------------------------
-- lead_data.assigned_user_id
-- ---------------------------------------------------------------------------
alter table public.lead_data add column assigned_user_id uuid;

alter table public.lead_data
  add constraint lead_data_assignee_membership_fk
  foreign key (tenant_id, assigned_user_id)
  references public.tenant_memberships (tenant_id, user_id)
  on delete set null (assigned_user_id);

create index lead_data_tenant_assignee_idx
  on public.lead_data (tenant_id, assigned_user_id, lead_created_time desc)
  where assigned_user_id is not null;

-- ---------------------------------------------------------------------------
-- Rules: one assignee per (tenant, ad)
-- ---------------------------------------------------------------------------
create table public.lead_ad_assignment_rules (
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  ad_id text not null,
  assignee_user_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, ad_id),
  constraint lead_ad_assignment_rules_ad_fk foreign key (tenant_id, ad_id)
    references public.meta_ads (tenant_id, ad_id) on delete cascade,
  constraint lead_ad_assignment_rules_member_fk foreign key (tenant_id, assignee_user_id)
    references public.tenant_memberships (tenant_id, user_id) on delete cascade
);
create index lead_ad_assignment_rules_assignee_idx on public.lead_ad_assignment_rules (tenant_id, assignee_user_id);

create trigger lead_ad_assignment_rules_set_updated_at before update on public.lead_ad_assignment_rules
  for each row execute function public.set_updated_at();

alter table public.lead_ad_assignment_rules enable row level security;
alter table public.lead_ad_assignment_rules force row level security;
-- service_role is named too: Supabase's default privileges hand it every right on a new public table.
revoke all on table public.lead_ad_assignment_rules from public, anon, authenticated, service_role;
-- Read only: rules are written exclusively by set_lead_ad_assignment_rule.
grant select on table public.lead_ad_assignment_rules to service_role;

-- ---------------------------------------------------------------------------
-- Timeline: a new activity type
-- ---------------------------------------------------------------------------
alter table public.lead_activities drop constraint lead_activities_type_check;
alter table public.lead_activities add constraint lead_activities_type_check check (type in (
  'lead_created', 'status_change', 'note_added',
  'task_created', 'task_rescheduled', 'task_completed', 'task_cancelled',
  'lead_assigned'
));

-- A person's name for the timeline text. Never raises and never returns NULL.
create or replace function public.assignee_display_name(p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select nullif(pg_catalog.btrim(p.full_name), '') from public.profiles as p where p.user_id = p_user_id),
    'a team member'
  );
$$;
revoke all on function public.assignee_display_name(uuid) from public, anon, authenticated;

create or replace function public.log_lead_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_summary text;
  v_actor uuid;
begin
  if TG_OP = 'INSERT' then
    -- Only the auto-assign trigger can set this on insert, so it is always System.
    insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
    values (
      new.tenant_id, new.id, 'lead_assigned',
      'Auto-assigned to ' || public.assignee_display_name(new.assigned_user_id),
      pg_catalog.jsonb_build_object('old', null, 'new', new.assigned_user_id, 'auto', true),
      null
    );
    return null;
  end if;

  v_actor := public.current_timeline_actor();
  v_summary := case
    when new.assigned_user_id is null then 'Unassigned (was ' || public.assignee_display_name(old.assigned_user_id) || ')'
    when old.assigned_user_id is null then 'Assigned to ' || public.assignee_display_name(new.assigned_user_id)
    else 'Reassigned: ' || public.assignee_display_name(old.assigned_user_id) || ' → ' || public.assignee_display_name(new.assigned_user_id)
  end;
  insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
  values (
    new.tenant_id, new.id, 'lead_assigned', pg_catalog.left(v_summary, 500),
    pg_catalog.jsonb_build_object('old', old.assigned_user_id, 'new', new.assigned_user_id, 'auto', false),
    v_actor
  );
  return null;
end;
$$;
revoke all on function public.log_lead_assignment() from public, anon, authenticated;

create trigger lead_data_log_assignment_insert after insert on public.lead_data
  for each row when (new.assigned_user_id is not null)
  execute function public.log_lead_assignment();
create trigger lead_data_log_assignment_change after update of assigned_user_id on public.lead_data
  for each row when (old.assigned_user_id is distinct from new.assigned_user_id)
  execute function public.log_lead_assignment();

-- ---------------------------------------------------------------------------
-- Auto-assign: BEFORE INSERT, so the lead is stored already assigned.
-- ---------------------------------------------------------------------------
create or replace function public.assign_lead_from_ad_rule()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_user_id is null and new.ad_id is not null then
    select rule.assignee_user_id into new.assigned_user_id
    from public.lead_ad_assignment_rules as rule
    join public.tenant_memberships as member
      on member.tenant_id = rule.tenant_id
     and member.user_id = rule.assignee_user_id
     and member.membership_status = 'active'
    where rule.tenant_id = new.tenant_id and rule.ad_id = new.ad_id;
  end if;
  return new;
end;
$$;
revoke all on function public.assign_lead_from_ad_rule() from public, anon, authenticated;

create trigger assign_lead_from_ad_rule before insert on public.lead_data
  for each row execute function public.assign_lead_from_ad_rule();

-- ---------------------------------------------------------------------------
-- Service-role RPCs
-- ---------------------------------------------------------------------------
create or replace function public.assert_active_tenant_owner(p_tenant_id uuid, p_user_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_tenant_id is null or p_user_id is null then
    raise exception 'Tenant and actor are required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.tenant_memberships as m
    where m.tenant_id = p_tenant_id and m.user_id = p_user_id
      and m.membership_role = 'owner' and m.membership_status = 'active'
  ) then
    raise exception 'Only the active tenant owner can manage ad assignment' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.assert_active_tenant_owner(uuid, uuid) from public, anon, authenticated;

-- Assign (or, with a NULL assignee, unassign) one lead. Any active member may do it, like a status change.
-- The assignee must be an ACTIVE member of the same tenant (22023 otherwise). No row = not this tenant's lead.
create or replace function public.assign_lead(
  p_tenant_id uuid, p_lead_id uuid, p_assignee_user_id uuid, p_actor_user_id uuid
)
returns table (lead_id uuid, lead_assignee_user_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_active_tenant_member(p_tenant_id, p_actor_user_id);
  if p_assignee_user_id is not null and not exists (
    select 1 from public.tenant_memberships as m
    where m.tenant_id = p_tenant_id and m.user_id = p_assignee_user_id and m.membership_status = 'active'
  ) then
    raise exception 'The assignee must be an active member of this company' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('app.current_user_id', p_actor_user_id::text, true);
  return query
    with updated as (
      update public.lead_data as ld
      set assigned_user_id = p_assignee_user_id
      where ld.tenant_id = p_tenant_id and ld.id = p_lead_id
      returning ld.id, ld.assigned_user_id
    )
    select updated.id, updated.assigned_user_id from updated;
  perform pg_catalog.set_config('app.current_user_id', '', true);
end;
$$;

-- Owner only. A NULL assignee clears the rule. Returns UPDATED | CLEARED | AD_NOT_FOUND | INVALID_ASSIGNEE.
create or replace function public.set_lead_ad_assignment_rule(
  p_tenant_id uuid, p_owner_user_id uuid, p_ad_id text, p_assignee_user_id uuid
)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_active_tenant_owner(p_tenant_id, p_owner_user_id);
  if p_ad_id is null or pg_catalog.length(pg_catalog.btrim(p_ad_id)) = 0 then
    return 'AD_NOT_FOUND';
  end if;
  if not exists (select 1 from public.meta_ads as a where a.tenant_id = p_tenant_id and a.ad_id = p_ad_id) then
    return 'AD_NOT_FOUND';
  end if;

  if p_assignee_user_id is null then
    delete from public.lead_ad_assignment_rules as r where r.tenant_id = p_tenant_id and r.ad_id = p_ad_id;
    return 'CLEARED';
  end if;

  if not exists (
    select 1 from public.tenant_memberships as m
    where m.tenant_id = p_tenant_id and m.user_id = p_assignee_user_id and m.membership_status = 'active'
  ) then
    return 'INVALID_ASSIGNEE';
  end if;

  insert into public.lead_ad_assignment_rules (tenant_id, ad_id, assignee_user_id, created_by)
  values (p_tenant_id, p_ad_id, p_assignee_user_id, p_owner_user_id)
  on conflict (tenant_id, ad_id) do update
    set assignee_user_id = excluded.assignee_user_id, created_by = excluded.created_by;
  return 'UPDATED';
end;
$$;

-- Owner only. Gives the ad's rule assignee every lead of that ad that is still unassigned; leads that already
-- have an assignee are never touched. Returns how many leads changed. No rule = P0002; assignee blocked = 22023.
create or replace function public.apply_lead_ad_assignment_rule(
  p_tenant_id uuid, p_owner_user_id uuid, p_ad_id text
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_assignee uuid;
  v_count integer;
begin
  perform public.assert_active_tenant_owner(p_tenant_id, p_owner_user_id);
  select r.assignee_user_id into v_assignee
  from public.lead_ad_assignment_rules as r
  where r.tenant_id = p_tenant_id and r.ad_id = p_ad_id;
  if v_assignee is null then
    raise exception 'This ad has no assignment rule' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.tenant_memberships as m
    where m.tenant_id = p_tenant_id and m.user_id = v_assignee and m.membership_status = 'active'
  ) then
    raise exception 'The assignee must be an active member of this company' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('app.current_user_id', p_owner_user_id::text, true);
  update public.lead_data as ld
  set assigned_user_id = v_assignee
  where ld.tenant_id = p_tenant_id and ld.ad_id = p_ad_id and ld.assigned_user_id is null;
  get diagnostics v_count = row_count;
  perform pg_catalog.set_config('app.current_user_id', '', true);
  return v_count;
end;
$$;

-- The owner's rules screen: every known ad of the tenant, its rule, and how many of its leads are unassigned.
create or replace function public.list_lead_ad_assignments(p_tenant_id uuid)
returns table (ad_id text, ad_name text, assignee_user_id uuid, total_leads bigint, unassigned_leads bigint)
language sql stable security definer set search_path = '' as $$
  select a.ad_id, a.ad_name, r.assignee_user_id,
         count(l.id) as total_leads,
         count(l.id) filter (where l.assigned_user_id is null) as unassigned_leads
  from public.meta_ads as a
  left join public.lead_ad_assignment_rules as r on r.tenant_id = a.tenant_id and r.ad_id = a.ad_id
  left join public.lead_data as l on l.tenant_id = a.tenant_id and l.ad_id = a.ad_id
  where a.tenant_id = p_tenant_id
  group by a.ad_id, a.ad_name, r.assignee_user_id
  order by pg_catalog.lower(coalesce(a.ad_name, a.ad_id)), a.ad_id;
$$;

revoke all on function public.assign_lead(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_lead_ad_assignment_rule(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.apply_lead_ad_assignment_rule(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.list_lead_ad_assignments(uuid) from public, anon, authenticated;
grant execute on function public.assign_lead(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.set_lead_ad_assignment_rule(uuid, uuid, text, uuid) to service_role;
grant execute on function public.apply_lead_ad_assignment_rule(uuid, uuid, text) to service_role;
grant execute on function public.list_lead_ad_assignments(uuid) to service_role;

commit;
