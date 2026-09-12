-- Onboarding now records the tenant's timezone instead of leaving it at the 'UTC' default.
--
-- public.tenants.timezone defaults to 'UTC', and nothing ever wrote it: complete_owner_onboarding
-- inserted only (tenant_name, tenant_status). But the application treats 'UTC' as "no verified
-- timezone" — getTenantTimezone in src/lib/server/lead-query-service.ts raises
-- TENANT_TIMEZONE_UNAVAILABLE (503) on it, and that call is the first line of queryLeads. So every
-- tenant created by the normal signup flow had a leads table and a CSV export that failed before
-- any filter ran. Both tenants existing on 2026-09-12 had to be corrected by hand.
--
-- The browser's own IANA zone is passed in and used whenever Postgres recognises it. Anything
-- missing, unrecognised, or 'UTC' falls back to Asia/Kolkata rather than failing onboarding: a
-- signup must not break over a timezone string, and this product onboards one market today — the
-- phone number a few lines below is required to normalise to an Indian number.
--
-- The four-argument version is dropped rather than left beside this one, so exactly one overload
-- exists and no caller can silently keep creating UTC tenants.
drop function if exists public.complete_owner_onboarding(text, text, text, text);

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

    -- A timezone the caller cannot supply, or one Postgres does not know, must not become a 'UTC'
    -- tenant: that is the value the application reads as "unverified" and refuses to serve leads
    -- for. Resolved here rather than in the client so the guarantee holds for every caller.
    v_timezone := btrim(coalesce(p_timezone, ''));
    if v_timezone = ''
        or v_timezone = 'UTC'
        or not exists (select 1 from pg_catalog.pg_timezone_names as tz where tz.name = v_timezone)
    then
        v_timezone := 'Asia/Kolkata';
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

revoke all on function public.complete_owner_onboarding(text, text, text, text, text) from public, anon;
grant execute on function public.complete_owner_onboarding(text, text, text, text, text) to authenticated;

-- Any tenant created before this migration is still carrying the unusable default.
update public.tenants set timezone = 'Asia/Kolkata' where timezone = 'UTC';
