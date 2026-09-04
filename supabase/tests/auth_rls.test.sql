-- pgTAP allow/deny tests for the login system's four tables
-- (login_system_plan.md section 12: "RLS and tenant isolation" +
-- "Subscription enforcement"). Run with the Supabase CLI:
--
--     supabase test db
--
-- This file has not been executed — no migration has been applied to any
-- Supabase project as part of this change. Run it after applying
-- 20260831000000_auth_and_tenancy_foundation.sql to a database that also
-- has pgTAP available (`create extension if not exists pgtap;`).
--
-- Authenticated-user simulation follows Supabase's own documented approach
-- for local RLS testing: switch to the `authenticated` role and set
-- `request.jwt.claims` so that `auth.uid()` (which reads
-- `request.jwt.claims ->> 'sub'`) resolves to the desired test user. No
-- third-party test-helper extension is assumed, since this repository does
-- not yet depend on one.

begin;

select plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures: two tenants (A, B), each with one owner, created directly as
-- the table owner (bypassing RLS) so the tests below can isolate exactly
-- one behaviour per assertion.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
    ('00000000-0000-0000-0000-000000000001', 'owner-a@example.com'),
    ('00000000-0000-0000-0000-000000000002', 'owner-b@example.com'),
    ('00000000-0000-0000-0000-000000000003', 'no-membership@example.com');

insert into public.tenants (tenant_id, tenant_name, tenant_status) values
    ('10000000-0000-0000-0000-000000000001', 'Tenant A', 'active'),
    ('10000000-0000-0000-0000-000000000002', 'Tenant B', 'active');

insert into public.profiles (user_id, full_name, phone_number, professional_role) values
    ('00000000-0000-0000-0000-000000000001', 'Owner A', '9990000001', 'Real Estate Agent'),
    ('00000000-0000-0000-0000-000000000002', 'Owner B', '9990000002', 'Real Estate Agent');

insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status) values
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner', 'active'),
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'owner', 'active');

-- Tenant A: subscription still trialing and valid.
insert into public.tenants_subscriptions (tenant_id, subscription_status, trial_started_at, trial_ends_at) values
    ('10000000-0000-0000-0000-000000000001', 'trialing', now(), now() + interval '14 days');

-- Tenant B: subscription trial already expired.
insert into public.tenants_subscriptions (tenant_id, subscription_status, trial_started_at, trial_ends_at) values
    ('10000000-0000-0000-0000-000000000002', 'trialing', now() - interval '20 days', now() - interval '6 days');

-- ---------------------------------------------------------------------------
-- Test helper: simulate an authenticated request as a given user.
--
-- `set_config('role', 'authenticated', true)` changes the effective role
-- for privilege/RLS checks exactly as `SET LOCAL ROLE authenticated` would
-- (the `role` GUC's assign hook performs the identical membership check
-- that the SET ROLE command performs), while remaining an ordinary
-- function call that PERFORM can invoke from a plpgsql body. This mirrors
-- the established Supabase pgTAP convention for authenticating as a test
-- user, without depending on a third-party test-helper extension.
-- ---------------------------------------------------------------------------
create schema if not exists tests;

create or replace function tests.authenticate_as(target_user_id uuid)
returns void
language plpgsql
as $$
begin
    perform set_config(
        'request.jwt.claims',
        json_build_object('sub', target_user_id::text, 'role', 'authenticated')::text,
        true
    );
    perform set_config('role', 'authenticated', true);
end;
$$;

-- ===========================================================================
-- 1. anon cannot read or write any of the four tables (plan section 12.7).
-- ===========================================================================
set local role anon;

select throws_ok(
    $$ select * from public.profiles $$,
    '42501',
    null,
    'anon cannot select from public.profiles'
);

select throws_ok(
    $$ select * from public.tenants $$,
    '42501',
    null,
    'anon cannot select from public.tenants'
);

select throws_ok(
    $$ select * from public.tenant_memberships $$,
    '42501',
    null,
    'anon cannot select from public.tenant_memberships'
);

select throws_ok(
    $$ select * from public.tenants_subscriptions $$,
    '42501',
    null,
    'anon cannot select from public.tenants_subscriptions'
);

select throws_ok(
    $$ insert into public.tenants (tenant_name) values ('Rogue Tenant') $$,
    '42501',
    null,
    'anon cannot insert into public.tenants'
);

reset role;

-- ===========================================================================
-- 2. Tenant A cannot read Tenant B's rows, and vice versa (plan section 12.8).
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-000000000001');

select is(
    (select count(*)::int from public.tenants where tenant_id = '10000000-0000-0000-0000-000000000002'),
    0,
    'Tenant A owner cannot read Tenant B''s tenant row'
);

select is(
    (select count(*)::int from public.tenant_memberships where tenant_id = '10000000-0000-0000-0000-000000000002'),
    0,
    'Tenant A owner cannot read Tenant B''s membership row'
);

select is(
    (select count(*)::int from public.tenants_subscriptions where tenant_id = '10000000-0000-0000-0000-000000000002'),
    0,
    'Tenant A owner cannot read Tenant B''s subscription row'
);

select is(
    (select count(*)::int from public.profiles where user_id = '00000000-0000-0000-0000-000000000002'),
    0,
    'Tenant A owner cannot read Tenant B owner''s profile row'
);

select is(
    (select count(*)::int from public.tenants where tenant_id = '10000000-0000-0000-0000-000000000001'),
    1,
    'Tenant A owner can read their own tenant row'
);

-- ===========================================================================
-- 3. Tenant A cannot update Tenant B's rows (plan section 12.9). No UPDATE
--    privilege was granted on public.tenants to `authenticated` at all
--    (plan section 8.3: "no unrestricted browser update"), so this fails at
--    the privilege-check stage before RLS is even evaluated.
-- ===========================================================================
select throws_ok(
    $$ update public.tenants set tenant_name = 'Hijacked' where tenant_id = '10000000-0000-0000-0000-000000000002' $$,
    '42501',
    null,
    'Tenant A owner cannot update Tenant B''s tenant row (no UPDATE grant on tenants)'
);

-- ===========================================================================
-- 4. A user cannot change their own membership role or tenant (plan section 12.10),
--    and cannot activate/extend their own subscription (plan section 12.11) —
--    both because no UPDATE privilege was granted on these tables at all.
-- ===========================================================================
select throws_ok(
    $$ update public.tenant_memberships set membership_role = 'admin' where user_id = '00000000-0000-0000-0000-000000000001' $$,
    '42501',
    null,
    'authenticated user cannot update their own membership_role (no UPDATE grant on tenant_memberships)'
);

select throws_ok(
    $$ update public.tenants_subscriptions set subscription_status = 'active', current_period_ends_at = now() + interval '1 year' where tenant_id = '10000000-0000-0000-0000-000000000001' $$,
    '42501',
    null,
    'authenticated user cannot activate/extend their own subscription (no UPDATE grant on tenants_subscriptions)'
);

-- ===========================================================================
-- 5. A user can update only the approved fields on their own profile
--    (plan section 12.12), and cannot change user_id.
-- ===========================================================================
select lives_ok(
    $$ update public.profiles set full_name = 'Owner A Updated' where user_id = '00000000-0000-0000-0000-000000000001' $$,
    'authenticated user can update their own approved profile fields'
);

select throws_ok(
    $$ update public.profiles set user_id = '00000000-0000-0000-0000-000000000002' where user_id = '00000000-0000-0000-0000-000000000001' $$,
    '42501',
    null,
    'authenticated user cannot change their own user_id (column not included in the UPDATE grant)'
);

-- ===========================================================================
-- 6. Direct table inserts from an authenticated browser are rejected
--    (plan section 12.13) — onboarding is RPC-only.
-- ===========================================================================
select throws_ok(
    $$ insert into public.tenant_memberships (tenant_id, user_id) values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003') $$,
    '42501',
    null,
    'authenticated user cannot directly insert a tenant_memberships row'
);

reset role;

-- ===========================================================================
-- 7. Subscription enforcement via private.has_crm_access (plan section 12.14-19).
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-000000000001');

select ok(
    private.has_crm_access('10000000-0000-0000-0000-000000000001'),
    'A valid trial (trial_ends_at in the future) grants CRM access'
);

select tests.authenticate_as('00000000-0000-0000-0000-000000000002');

select ok(
    not private.has_crm_access('10000000-0000-0000-0000-000000000002'),
    'An expired trial (trial_ends_at in the past) denies CRM access even though the stored status still says trialing'
);

reset role;

select * from finish();

rollback;
