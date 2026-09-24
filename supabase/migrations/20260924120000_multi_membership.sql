-- Multi-membership: one person (one auth.users id, one profiles row) can belong to many tenants,
-- like Slack or Figma workspaces. Until now tenant_memberships_user_id_key limited every user to a
-- single company. After this migration:
--
--   * tenant_memberships is unique per (tenant_id, user_id) only — that constraint already exists.
--   * A person may OWN at most one tenant (every new tenant carries its own free trial), and may be
--     an employee of any number of tenants.
--   * An invitation is open at most once per (tenant, email), so two companies can invite the same
--     person at the same time.
--   * Someone who already has a profile joins a further company with one click
--     (join_invited_workspace) or declines it (decline_member_invitation); only a first-time invitee
--     fills in the personal-details form (accept_member_invitation).
--   * "Create new company" (create_owned_workspace) asks only for the company name and reuses the
--     caller's existing profile.
--   * Removing an employee deletes only that tenant's membership and that tenant's invitation rows,
--     and records who removed whom in tenant_member_removals. The shared profile is never touched.
begin;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------
alter table public.tenant_memberships drop constraint tenant_memberships_user_id_key;

-- One owned tenant per person. Also the guard that turns a concurrent double onboarding into a
-- unique_violation, the job tenant_memberships_user_id_key used to do.
create unique index tenant_memberships_one_owned_tenant_per_user_idx
    on public.tenant_memberships (user_id)
    where membership_role = 'owner';

create index tenant_memberships_user_id_idx
    on public.tenant_memberships (user_id);

drop index public.invitation_member_one_pending_per_email_idx;

-- One open invitation per person per company; different companies may invite the same person.
create unique index invitation_member_one_pending_per_tenant_email_idx
    on public.invitation_member (tenant_id, email)
    where status = 'pending';

alter table public.invitation_member drop constraint invitation_member_status_check;
alter table public.invitation_member add constraint invitation_member_status_check
    check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired'));

-- ---------------------------------------------------------------------------
-- Removal audit trail — server-only.
-- ---------------------------------------------------------------------------
create table public.tenant_member_removals (
    removal_id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
    removed_user_id uuid references auth.users (id) on delete set null,
    removed_by uuid references auth.users (id) on delete set null,
    membership_role text not null,
    removed_at timestamptz not null default now()
);

create index tenant_member_removals_tenant_idx
    on public.tenant_member_removals (tenant_id, removed_at desc);

alter table public.tenant_member_removals enable row level security;
alter table public.tenant_member_removals force row level security;

revoke all on table public.tenant_member_removals from public, anon, authenticated;
grant select, insert on table public.tenant_member_removals to service_role;

-- ---------------------------------------------------------------------------
-- create_member_invitation — "already a member" now means a member of THIS tenant.
-- ---------------------------------------------------------------------------
create or replace function public.create_member_invitation(
    p_tenant_id uuid,
    p_invited_by uuid,
    p_email text,
    p_membership_role text
)
returns table (
    outcome text,
    invitation_id uuid,
    user_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_email text;
    v_existing_user_id uuid;
    v_invitation_id uuid;
begin
    v_email := lower(btrim(coalesce(p_email, '')));
    if length(v_email) < 3 or length(v_email) > 320 or position('@' in v_email) <= 1 then
        return query select 'INVALID_EMAIL'::text, null::uuid, null::uuid;
        return;
    end if;

    if p_membership_role is null or p_membership_role not in ('admin', 'employee') then
        return query select 'INVALID_ROLE'::text, null::uuid, null::uuid;
        return;
    end if;

    if not exists (
        select 1
        from public.tenant_memberships as tm
        join public.tenants as t on t.tenant_id = tm.tenant_id
        where tm.tenant_id = p_tenant_id
          and tm.user_id = p_invited_by
          and tm.membership_role = 'owner'
          and tm.membership_status = 'active'
          and t.tenant_status = 'active'
    ) then
        return query select 'NOT_OWNER'::text, null::uuid, null::uuid;
        return;
    end if;

    select u.id into v_existing_user_id
    from auth.users as u
    where lower(u.email) = v_email
    limit 1;

    -- A person may belong to many companies, but only once to each.
    if v_existing_user_id is not null and exists (
        select 1
        from public.tenant_memberships as tm
        where tm.tenant_id = p_tenant_id
          and tm.user_id = v_existing_user_id
    ) then
        return query select 'ALREADY_MEMBER'::text, null::uuid, v_existing_user_id;
        return;
    end if;

    -- A lapsed invitation must not block a fresh one.
    update public.invitation_member as im
    set status = 'expired'
    where im.email = v_email
      and im.status = 'pending'
      and im.expires_at <= now();

    begin
        insert into public.invitation_member (tenant_id, email, user_id, membership_role, invited_by)
        values (p_tenant_id, v_email, v_existing_user_id, p_membership_role, p_invited_by)
        returning invitation_member.invitation_id into v_invitation_id;
    exception
        when unique_violation then
            return query select 'ALREADY_INVITED'::text, null::uuid, v_existing_user_id;
            return;
    end;

    return query select 'CREATED'::text, v_invitation_id, v_existing_user_id;
end;
$$;

revoke all on function public.create_member_invitation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_member_invitation(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- accept_member_invitation — a first-time invitee's setup form. Now names the exact invitation,
-- because a person can hold open invitations from several companies at once.
-- ---------------------------------------------------------------------------
drop function if exists public.accept_member_invitation(text, text, text);

create or replace function public.accept_member_invitation(
    p_invitation_id uuid,
    p_full_name text,
    p_phone_number text,
    p_professional_role text
)
returns table (
    tenant_id uuid,
    membership_role text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
    v_email text;
    v_full_name text;
    v_phone_number text;
    v_professional_role text;
    v_invitation public.invitation_member%rowtype;
    v_existing_role text;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Authentication is required to accept an invitation' using errcode = '28000';
    end if;

    v_email := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));

    v_full_name := btrim(coalesce(p_full_name, ''));
    v_phone_number := btrim(coalesce(p_phone_number, ''));
    v_professional_role := btrim(coalesce(p_professional_role, ''));

    if length(v_full_name) = 0 or length(v_full_name) > 200 then
        raise exception 'Full name must be between 1 and 200 characters' using errcode = '22023';
    end if;
    if length(v_phone_number) = 0 or length(v_phone_number) > 32 then
        raise exception 'Phone number must be between 1 and 32 characters' using errcode = '22023';
    end if;
    if length(v_professional_role) = 0 or length(v_professional_role) > 120 then
        raise exception 'Professional role must be between 1 and 120 characters' using errcode = '22023';
    end if;

    -- The invitation must belong to the caller: by user id, or by the session's verified email for
    -- a row whose user id was never written back.
    select im.* into v_invitation
    from public.invitation_member as im
    where im.invitation_id = p_invitation_id
      and (
          im.user_id = v_user_id
          or (im.user_id is null and v_email <> '' and im.email = v_email)
      )
    for update;

    if v_invitation.invitation_id is null then
        raise exception 'No pending invitation was found for this account' using errcode = 'P0002';
    end if;

    -- Idempotency for a retry / double-click after a successful accept of this same invitation.
    select tm.membership_role into v_existing_role
    from public.tenant_memberships as tm
    where tm.tenant_id = v_invitation.tenant_id
      and tm.user_id = v_user_id;

    if v_existing_role is not null then
        return query select v_invitation.tenant_id, v_existing_role;
        return;
    end if;

    if v_invitation.status <> 'pending' or v_invitation.expires_at <= now() then
        raise exception 'No pending invitation was found for this account' using errcode = 'P0002';
    end if;

    insert into public.profiles (user_id, full_name, phone_number, professional_role)
    values (v_user_id, v_full_name, v_phone_number, v_professional_role)
    on conflict (user_id) do update
        set full_name = excluded.full_name,
            phone_number = excluded.phone_number,
            professional_role = excluded.professional_role;

    insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status)
    values (v_invitation.tenant_id, v_user_id, v_invitation.membership_role, 'active');

    update public.invitation_member as im
    set status = 'accepted',
        accepted_at = now(),
        user_id = v_user_id
    where im.invitation_id = v_invitation.invitation_id;

    return query select v_invitation.tenant_id, v_invitation.membership_role;
end;
$$;

revoke all on function public.accept_member_invitation(uuid, text, text, text) from public, anon;
grant execute on function public.accept_member_invitation(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- join_invited_workspace — one-click accept for someone who already has a profile. Their name,
-- phone and job title are reused; the company and role come from the invitation.
-- ---------------------------------------------------------------------------
create or replace function public.join_invited_workspace(p_invitation_id uuid)
returns table (
    tenant_id uuid,
    membership_role text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
    v_email text;
    v_invitation public.invitation_member%rowtype;
    v_existing_role text;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Authentication is required to accept an invitation' using errcode = '28000';
    end if;

    v_email := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));

    if not exists (select 1 from public.profiles as p where p.user_id = v_user_id) then
        raise exception 'Complete your account setup before joining another company' using errcode = 'P0001';
    end if;

    select im.* into v_invitation
    from public.invitation_member as im
    where im.invitation_id = p_invitation_id
      and (
          im.user_id = v_user_id
          or (im.user_id is null and v_email <> '' and im.email = v_email)
      )
    for update;

    if v_invitation.invitation_id is null then
        raise exception 'No pending invitation was found for this account' using errcode = 'P0002';
    end if;

    -- Idempotency for a double-click.
    select tm.membership_role into v_existing_role
    from public.tenant_memberships as tm
    where tm.tenant_id = v_invitation.tenant_id
      and tm.user_id = v_user_id;

    if v_existing_role is not null then
        return query select v_invitation.tenant_id, v_existing_role;
        return;
    end if;

    if v_invitation.status <> 'pending' or v_invitation.expires_at <= now() then
        raise exception 'No pending invitation was found for this account' using errcode = 'P0002';
    end if;

    insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status)
    values (v_invitation.tenant_id, v_user_id, v_invitation.membership_role, 'active')
    on conflict on constraint tenant_memberships_tenant_id_user_id_key do nothing;

    update public.invitation_member as im
    set status = 'accepted',
        accepted_at = now(),
        user_id = v_user_id
    where im.invitation_id = v_invitation.invitation_id;

    return query select v_invitation.tenant_id, v_invitation.membership_role;
end;
$$;

revoke all on function public.join_invited_workspace(uuid) from public, anon;
grant execute on function public.join_invited_workspace(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- decline_member_invitation — the invitee turns down one of their own pending invitations.
-- ---------------------------------------------------------------------------
create or replace function public.decline_member_invitation(p_invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
    v_email text;
    v_declined_id uuid;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Authentication is required to decline an invitation' using errcode = '28000';
    end if;

    v_email := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));

    update public.invitation_member as im
    set status = 'declined'
    where im.invitation_id = p_invitation_id
      and im.status = 'pending'
      and (
          im.user_id = v_user_id
          or (im.user_id is null and v_email <> '' and im.email = v_email)
      )
    returning im.invitation_id into v_declined_id;

    return v_declined_id is not null;
end;
$$;

revoke all on function public.decline_member_invitation(uuid) from public, anon;
grant execute on function public.decline_member_invitation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- complete_owner_onboarding — unchanged except that "already onboarded" now means "already OWNS a
-- tenant". An employee membership elsewhere must never be handed back as the caller's own company.
-- ---------------------------------------------------------------------------
create or replace function public.complete_owner_onboarding(
    p_full_name text,
    p_phone_number text,
    p_tenant_name text,
    p_professional_role text,
    p_timezone text default null
)
returns table (
    tenant_id uuid,
    subscription_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
    v_full_name text;
    v_phone_number text;
    v_tenant_name text;
    v_professional_role text;
    v_timezone text;
    v_existing_tenant_id uuid;
    v_existing_subscription_status text;
    v_tenant_id uuid;
    v_membership_id uuid;
    v_subscription_id uuid;
    v_trial_started_at timestamptz;
    v_trial_ends_at timestamptz;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Authentication is required to complete onboarding' using errcode = '28000';
    end if;

    v_full_name := btrim(p_full_name);
    v_phone_number := btrim(p_phone_number);
    v_tenant_name := btrim(p_tenant_name);
    v_professional_role := btrim(p_professional_role);

    if length(v_full_name) = 0 or length(v_full_name) > 200 then
        raise exception 'Full name must be between 1 and 200 characters' using errcode = '22023';
    end if;
    if length(v_phone_number) = 0 or length(v_phone_number) > 32 then
        raise exception 'Phone number must be between 1 and 32 characters' using errcode = '22023';
    end if;
    if length(v_tenant_name) = 0 or length(v_tenant_name) > 200 then
        raise exception 'Company name must be between 1 and 200 characters' using errcode = '22023';
    end if;
    if length(v_professional_role) = 0 or length(v_professional_role) > 120 then
        raise exception 'Professional role must be between 1 and 120 characters' using errcode = '22023';
    end if;

    v_timezone := btrim(coalesce(p_timezone, ''));
    if v_timezone = ''
        or v_timezone = 'UTC'
        or not exists (select 1 from pg_catalog.pg_timezone_names as tz where tz.name = v_timezone)
    then
        v_timezone := 'Asia/Kolkata';
    end if;

    -- Idempotency for a sequential retry / double-click: if this user already owns a tenant,
    -- return it and do not create a second one.
    select tm.tenant_id, ts.subscription_status
    into v_existing_tenant_id, v_existing_subscription_status
    from public.tenant_memberships as tm
    join public.tenants_subscriptions as ts on ts.tenant_id = tm.tenant_id
    where tm.user_id = v_user_id
      and tm.membership_role = 'owner';

    if v_existing_tenant_id is not null then
        return query select v_existing_tenant_id, v_existing_subscription_status;
        return;
    end if;

    v_trial_started_at := now();
    v_trial_ends_at := v_trial_started_at + interval '14 days';

    insert into public.profiles (user_id, full_name, phone_number, professional_role)
    values (v_user_id, v_full_name, v_phone_number, v_professional_role)
    on conflict (user_id) do update
        set full_name = excluded.full_name,
            phone_number = excluded.phone_number,
            professional_role = excluded.professional_role;

    begin
        insert into public.tenants (tenant_name, tenant_status, timezone)
        values (v_tenant_name, 'active', v_timezone)
        returning tenants.tenant_id into v_tenant_id;

        insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status)
        values (v_tenant_id, v_user_id, 'owner', 'active')
        returning tenant_memberships.tenant_membership_id into v_membership_id;

        insert into public.tenants_subscriptions (
            tenant_id, subscription_status, trial_started_at, trial_ends_at
        ) values (
            v_tenant_id, 'trialing', v_trial_started_at, v_trial_ends_at
        ) returning tenants_subscriptions.tenant_subscription_id into v_subscription_id;
    exception
        when unique_violation then
            -- A concurrent call won the one-owned-tenant race; this block's savepoint discards the
            -- tenant this call just inserted, and the winner's tenant is returned instead.
            select tm.tenant_id, ts.subscription_status
            into v_existing_tenant_id, v_existing_subscription_status
            from public.tenant_memberships as tm
            join public.tenants_subscriptions as ts on ts.tenant_id = tm.tenant_id
            where tm.user_id = v_user_id
              and tm.membership_role = 'owner';

            if v_existing_tenant_id is null then
                raise;
            end if;

            return query select v_existing_tenant_id, v_existing_subscription_status;
            return;
    end;

    if v_tenant_id is null or v_membership_id is null or v_subscription_id is null then
        raise exception 'Onboarding could not create a consistent ownership chain' using errcode = 'P0001';
    end if;

    return query select v_tenant_id, 'trialing'::text;
end;
$$;

revoke all on function public.complete_owner_onboarding(text, text, text, text, text) from public, anon;
grant execute on function public.complete_owner_onboarding(text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- create_owned_workspace — "Create new company" for someone who already has a profile. Asks only
-- for the company name. At most one owned tenant per person: a second call returns the first.
-- ---------------------------------------------------------------------------
create or replace function public.create_owned_workspace(
    p_tenant_name text,
    p_timezone text default null
)
returns table (
    tenant_id uuid,
    subscription_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
    v_tenant_name text;
    v_timezone text;
    v_existing_tenant_id uuid;
    v_existing_subscription_status text;
    v_tenant_id uuid;
    v_membership_id uuid;
    v_subscription_id uuid;
    v_trial_started_at timestamptz;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Authentication is required to create a company' using errcode = '28000';
    end if;

    if not exists (select 1 from public.profiles as p where p.user_id = v_user_id) then
        raise exception 'Complete your account setup before creating a company' using errcode = 'P0001';
    end if;

    v_tenant_name := btrim(coalesce(p_tenant_name, ''));
    if length(v_tenant_name) = 0 or length(v_tenant_name) > 200 then
        raise exception 'Company name must be between 1 and 200 characters' using errcode = '22023';
    end if;

    v_timezone := btrim(coalesce(p_timezone, ''));
    if v_timezone = ''
        or v_timezone = 'UTC'
        or not exists (select 1 from pg_catalog.pg_timezone_names as tz where tz.name = v_timezone)
    then
        v_timezone := 'Asia/Kolkata';
    end if;

    select tm.tenant_id, ts.subscription_status
    into v_existing_tenant_id, v_existing_subscription_status
    from public.tenant_memberships as tm
    join public.tenants_subscriptions as ts on ts.tenant_id = tm.tenant_id
    where tm.user_id = v_user_id
      and tm.membership_role = 'owner';

    if v_existing_tenant_id is not null then
        return query select v_existing_tenant_id, v_existing_subscription_status;
        return;
    end if;

    v_trial_started_at := now();

    begin
        insert into public.tenants (tenant_name, tenant_status, timezone)
        values (v_tenant_name, 'active', v_timezone)
        returning tenants.tenant_id into v_tenant_id;

        insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status)
        values (v_tenant_id, v_user_id, 'owner', 'active')
        returning tenant_memberships.tenant_membership_id into v_membership_id;

        insert into public.tenants_subscriptions (
            tenant_id, subscription_status, trial_started_at, trial_ends_at
        ) values (
            v_tenant_id, 'trialing', v_trial_started_at, v_trial_started_at + interval '14 days'
        ) returning tenants_subscriptions.tenant_subscription_id into v_subscription_id;
    exception
        when unique_violation then
            select tm.tenant_id, ts.subscription_status
            into v_existing_tenant_id, v_existing_subscription_status
            from public.tenant_memberships as tm
            join public.tenants_subscriptions as ts on ts.tenant_id = tm.tenant_id
            where tm.user_id = v_user_id
              and tm.membership_role = 'owner';

            if v_existing_tenant_id is null then
                raise;
            end if;

            return query select v_existing_tenant_id, v_existing_subscription_status;
            return;
    end;

    if v_tenant_id is null or v_membership_id is null or v_subscription_id is null then
        raise exception 'Company could not be created consistently' using errcode = 'P0001';
    end if;

    return query select v_tenant_id, 'trialing'::text;
end;
$$;

revoke all on function public.create_owned_workspace(text, text) from public, anon;
grant execute on function public.create_owned_workspace(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- remove_tenant_member — removes one employee from ONE tenant. Their profile and every other
-- membership stay. That tenant's invitation rows for them are deleted and the removal is audited.
-- ---------------------------------------------------------------------------
create or replace function public.remove_tenant_member(
    p_tenant_id uuid,
    p_owner_user_id uuid,
    p_member_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    removed_user_id uuid;
    removed_role text;
    removed_email text;
begin
    if not exists (
        select 1
        from public.tenant_memberships as owner_membership
        where owner_membership.tenant_id = p_tenant_id
          and owner_membership.user_id = p_owner_user_id
          and owner_membership.membership_role = 'owner'
          and owner_membership.membership_status = 'active'
    ) then
        raise exception 'Only the active tenant owner can remove members' using errcode = '42501';
    end if;

    delete from public.tenant_memberships as member_membership
    where member_membership.tenant_id = p_tenant_id
      and member_membership.user_id = p_member_user_id
      and member_membership.membership_role = 'employee'
    returning member_membership.user_id, member_membership.membership_role
    into removed_user_id, removed_role;

    if removed_user_id is null then
        return false;
    end if;

    select lower(u.email) into removed_email from auth.users as u where u.id = removed_user_id;

    delete from public.invitation_member as im
    where im.tenant_id = p_tenant_id
      and (im.user_id = removed_user_id or (removed_email is not null and im.email = removed_email));

    insert into public.tenant_member_removals (tenant_id, removed_user_id, removed_by, membership_role)
    values (p_tenant_id, removed_user_id, p_owner_user_id, removed_role);

    return true;
end;
$$;

revoke all on function public.remove_tenant_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_tenant_member(uuid, uuid, uuid) to service_role;

commit;
