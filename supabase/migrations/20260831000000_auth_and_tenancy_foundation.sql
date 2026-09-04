-- Passwordless email-OTP login system: foundation tables, RLS, and RPCs.
--
-- This migration is intentionally timestamped BEFORE 20260901150000 so that
-- the tenant_id foreign keys already present in the later migrations
-- (meta_connections, facebook_pages, lead_data, projects,
-- meta_ad_project_mappings, lead_project_assignment_audit) resolve against
-- the tables created here.
--
-- Naming is frozen per login_system_plan.md section 3:
--   tenants.tenant_id, tenant_memberships.tenant_membership_id,
--   tenants_subscriptions.tenant_subscription_id, profiles.user_id.
--
-- Supabase owns and manages auth.users. It is referenced here but never
-- created or modified by this migration.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared trigger function (also defined, identically, by the later
-- 20260901150000 migration via `create or replace`; defining it first here
-- keeps this file runnable on its own against an empty database).
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- 5.1 public.profiles — personal details belonging to one authenticated person.
create table public.profiles (
    user_id uuid primary key references auth.users (id) on delete cascade,
    full_name text not null check (length(btrim(full_name)) > 0),
    phone_number text not null check (length(btrim(phone_number)) > 0),
    professional_role text not null check (length(btrim(professional_role)) > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 5.2 public.tenants — one customer company; permanently owns that company's CRM data.
-- `timezone` is not part of the login plan's data contract but is required by
-- the already-shipped lead-query-service.ts (getTenantTimezone) and by the
-- validate_tenant_timezone trigger added later in
-- 20260902120000_lead_projects_and_search.sql; declaring it here makes that
-- migration's `add column if not exists` a no-op instead of a schema drift.
create table public.tenants (
    tenant_id uuid primary key default gen_random_uuid(),
    tenant_name text not null check (length(btrim(tenant_name)) > 0),
    tenant_status text not null default 'active'
        check (tenant_status in ('active', 'suspended', 'closed')),
    timezone text not null default 'UTC',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 5.3 public.tenant_memberships — authorizes a Supabase user to belong to a tenant.
create table public.tenant_memberships (
    tenant_membership_id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    membership_role text not null default 'owner'
        check (membership_role in ('owner', 'admin', 'employee')),
    membership_status text not null default 'active'
        check (membership_status in ('active', 'blocked')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Prevents duplicate membership for the same tenant/user pair, and is
    -- also the exact (tenant_id, user_id) unique target that
    -- lead_project_assignment_audit's foreign key
    -- (in 20260902120000_lead_projects_and_search.sql) requires.
    constraint tenant_memberships_tenant_id_user_id_key unique (tenant_id, user_id),
    -- Enforces the initial one-company-per-user rule.
    constraint tenant_memberships_user_id_key unique (user_id)
);

-- Only one `owner` membership is permitted per tenant.
create unique index tenant_memberships_one_owner_per_tenant_idx
    on public.tenant_memberships (tenant_id)
    where membership_role = 'owner';

-- 5.4 public.tenants_subscriptions — controls whether a tenant currently has CRM access.
-- Table name matches login_system_plan.md section 5.4 verbatim.
create table public.tenants_subscriptions (
    tenant_subscription_id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
    subscription_status text not null default 'trialing'
        check (subscription_status in ('trialing', 'active', 'blocked')),
    trial_started_at timestamptz not null default now(),
    trial_ends_at timestamptz not null default (now() + interval '14 days'),
    current_period_started_at timestamptz,
    current_period_ends_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- One tenant has exactly one subscription row.
    constraint tenants_subscriptions_tenant_id_key unique (tenant_id)
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger set_profiles_updated_at
    before update on public.profiles
    for each row execute function public.set_updated_at();

create trigger set_tenants_updated_at
    before update on public.tenants
    for each row execute function public.set_updated_at();

create trigger set_tenant_memberships_updated_at
    before update on public.tenant_memberships
    for each row execute function public.set_updated_at();

create trigger set_tenants_subscriptions_updated_at
    before update on public.tenants_subscriptions
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.tenants enable row level security;
alter table public.tenants force row level security;
alter table public.tenant_memberships enable row level security;
alter table public.tenant_memberships force row level security;
alter table public.tenants_subscriptions enable row level security;
alter table public.tenants_subscriptions force row level security;

revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.tenants from public, anon, authenticated;
revoke all on table public.tenant_memberships from public, anon, authenticated;
revoke all on table public.tenants_subscriptions from public, anon, authenticated;

-- 8.1 anon receives no access to any of the four tables (nothing granted above).

-- 8.2 profiles: authenticated may read their own row and update only the
-- allowed personal columns; user_id can never be part of an update grant.
grant select on table public.profiles to authenticated;
grant update (full_name, phone_number, professional_role) on table public.profiles to authenticated;

-- 8.3 tenants: authenticated may read only a tenant connected to their membership.
grant select on table public.tenants to authenticated;

-- 8.4 tenant_memberships: authenticated may read only their own membership row.
grant select on table public.tenant_memberships to authenticated;

-- 8.5 tenants_subscriptions: authenticated may read only their tenant's subscription.
grant select on table public.tenants_subscriptions to authenticated;

-- The trusted backend (service role) is the only writer for all four tables;
-- in practice writes happen exclusively through the SECURITY DEFINER RPCs
-- below, but the grant is kept here for operational/administrative access.
grant select, insert, update on table public.profiles to service_role;
grant select, insert, update on table public.tenants to service_role;
grant select, insert, update on table public.tenant_memberships to service_role;
grant select, insert, update on table public.tenants_subscriptions to service_role;

create policy profiles_select_own on public.profiles
    for select to authenticated
    using (user_id = auth.uid());

create policy profiles_update_own on public.profiles
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

create policy tenants_select_own on public.tenants
    for select to authenticated
    using (
        exists (
            select 1
            from public.tenant_memberships as membership
            where membership.tenant_id = tenants.tenant_id
              and membership.user_id = auth.uid()
        )
    );

create policy tenant_memberships_select_own on public.tenant_memberships
    for select to authenticated
    using (user_id = auth.uid());

create policy tenants_subscriptions_select_own on public.tenants_subscriptions
    for select to authenticated
    using (
        exists (
            select 1
            from public.tenant_memberships as membership
            where membership.tenant_id = tenants_subscriptions.tenant_id
              and membership.user_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- 8.6 Shared CRM-access authorization function.
--
-- Lives in a non-exposed `private` schema: Supabase's PostgREST layer only
-- exposes the `public` (and `graphql_public`) schema by default, so this
-- function is not reachable as a browser-callable RPC even though
-- `authenticated` is granted EXECUTE — that grant exists only so RLS
-- policies on future tenant-owned CRM tables, evaluated as the querying
-- role, can invoke it.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.has_crm_access(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.tenant_memberships as membership
        join public.tenants as tenant
            on tenant.tenant_id = membership.tenant_id
        join public.tenants_subscriptions as subscription
            on subscription.tenant_id = membership.tenant_id
        where membership.tenant_id = target_tenant_id
          and membership.user_id = auth.uid()
          and membership.membership_status = 'active'
          and tenant.tenant_status = 'active'
          and (
              (subscription.subscription_status = 'trialing' and subscription.trial_ends_at > now())
              or
              (subscription.subscription_status = 'active' and subscription.current_period_ends_at > now())
          )
    );
$$;

revoke all on function private.has_crm_access(uuid) from public, anon;
grant execute on function private.has_crm_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Owner onboarding RPC (login_system_plan.md section 6.4 and section 9).
--
-- Accepts only the four onboarding text values. Every trusted identifier,
-- role, status, and timestamp is derived server-side; none are accepted
-- from the caller. Idempotent: a caller who already completed onboarding
-- gets their existing tenant back. A concurrent duplicate call loses the
-- unique-constraint race and has its tenant/membership/subscription insert
-- attempt rolled back to the savepoint below, then also receives the
-- winning transaction's tenant instead of an opaque error.
-- ---------------------------------------------------------------------------
create or replace function public.complete_owner_onboarding(
    p_full_name text,
    p_phone_number text,
    p_tenant_name text,
    p_professional_role text
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

    -- Non-empty is the plan's data-contract requirement (section 5); the
    -- upper bounds below are this RPC's own length-limiting, required in
    -- general terms by section 9 ("Validate and length-limit all text
    -- inputs") but left to implementation judgment on the exact figure.
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

    -- Idempotency for a sequential retry / double-click: if this user
    -- already has a membership, return their existing tenant and do not
    -- create a second one.
    select tm.tenant_id, ts.subscription_status
    into v_existing_tenant_id, v_existing_subscription_status
    from public.tenant_memberships as tm
    join public.tenants_subscriptions as ts on ts.tenant_id = tm.tenant_id
    where tm.user_id = v_user_id;

    if v_existing_tenant_id is not null then
        return query select v_existing_tenant_id, v_existing_subscription_status;
        return;
    end if;

    v_trial_started_at := now();
    v_trial_ends_at := v_trial_started_at + interval '14 days';

    -- Idempotent regardless of race: if a profile row already exists for
    -- this user_id (e.g. a prior failed attempt after the profile insert
    -- but before the membership insert), refresh it rather than erroring.
    insert into public.profiles (user_id, full_name, phone_number, professional_role)
    values (v_user_id, v_full_name, v_phone_number, v_professional_role)
    on conflict (user_id) do update
        set full_name = excluded.full_name,
            phone_number = excluded.phone_number,
            professional_role = excluded.professional_role;

    begin
        insert into public.tenants (tenant_name, tenant_status)
        values (v_tenant_name, 'active')
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
            -- The BEGIN block above created an implicit savepoint; this
            -- rollback discards the just-inserted tenant, the failed
            -- membership insert, and any subscription insert attempted
            -- before the conflict, so no orphaned tenant is ever persisted
            -- by the losing transaction.
            select tm.tenant_id, ts.subscription_status
            into v_existing_tenant_id, v_existing_subscription_status
            from public.tenant_memberships as tm
            join public.tenants_subscriptions as ts on ts.tenant_id = tm.tenant_id
            where tm.user_id = v_user_id;

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

revoke all on function public.complete_owner_onboarding(text, text, text, text) from public, anon;
grant execute on function public.complete_owner_onboarding(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Trial/subscription reconciliation (login_system_plan.md section 7).
--
-- This is the visible-status housekeeping job, not the security boundary:
-- private.has_crm_access() above evaluates trial_ends_at /
-- current_period_ends_at directly, so access is denied at the exact expiry
-- instant even if this function has not run yet.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_tenant_subscriptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_updated_count integer;
begin
    with expired as (
        update public.tenants_subscriptions
        set subscription_status = 'blocked'
        where (
            (subscription_status = 'trialing' and trial_ends_at <= now())
            or
            (subscription_status = 'active' and current_period_ends_at is not null and current_period_ends_at <= now())
        )
        returning tenant_subscription_id
    )
    select count(*) into v_updated_count from expired;

    return v_updated_count;
end;
$$;

revoke all on function public.reconcile_tenant_subscriptions() from public, anon, authenticated;
grant execute on function public.reconcile_tenant_subscriptions() to service_role;
