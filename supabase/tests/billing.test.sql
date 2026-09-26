-- pgTAP tests for supabase/migrations/20260926120000_billing_razorpay.sql. Run with:
--
--     supabase test db
--
-- Covers: payment -> tenant mapping, idempotency, "access only moves forward", blocked -> active,
-- seat enforcement for trial and paid companies, and tenant/role isolation of billing rows.
-- Authenticated simulation follows supabase/tests/auth_rls.test.sql.

begin;

select plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures: Tenant A (owner A) and Tenant B (owner B), both on a valid trial.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
    ('00000000-0000-0000-0000-00000000000a', 'billing-owner-a@example.com'),
    ('00000000-0000-0000-0000-00000000000b', 'billing-owner-b@example.com'),
    ('00000000-0000-0000-0000-00000000000e', 'billing-employee-a@example.com');

insert into public.tenants (tenant_id, tenant_name, tenant_status) values
    ('10000000-0000-0000-0000-00000000000a', 'Billing Tenant A', 'active'),
    ('10000000-0000-0000-0000-00000000000b', 'Billing Tenant B', 'active');

insert into public.profiles (user_id, full_name, phone_number, professional_role) values
    ('00000000-0000-0000-0000-00000000000a', 'Owner A', '9990000101', 'Agent'),
    ('00000000-0000-0000-0000-00000000000b', 'Owner B', '9990000102', 'Agent'),
    ('00000000-0000-0000-0000-00000000000e', 'Employee A', '9990000103', 'Agent');

insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status) values
    ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'owner', 'active'),
    ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'owner', 'active');

insert into public.tenants_subscriptions (tenant_id, subscription_status, trial_started_at, trial_ends_at) values
    ('10000000-0000-0000-0000-00000000000a', 'trialing', now(), now() + interval '14 days'),
    ('10000000-0000-0000-0000-00000000000b', 'trialing', now(), now() + interval '14 days');

insert into public.billing_plans
    (billing_plan_id, plan_code, plan_name, tier, billing_period, razorpay_plan_id, price_per_seat_paise, total_count)
values
    ('20000000-0000-0000-0000-000000000001', 'pro_monthly', 'Pro Monthly', 'pro', 'monthly', 'plan_TESTPRO', 49900, 120);

-- Both tenants started a checkout; A for 2 seats.
insert into public.billing_subscriptions
    (billing_subscription_id, tenant_id, billing_plan_id, razorpay_subscription_id, seat_quantity, created_by_user_id)
values
    ('30000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000001',
     'sub_TESTA', 2, '00000000-0000-0000-0000-00000000000a'),
    ('30000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-000000000001',
     'sub_TESTB', 1, '00000000-0000-0000-0000-00000000000b');

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

-- Applies a captured payment for sub_TESTA with the given payment id, tenant and period.
create or replace function tests.pay_a(p_payment_id text, p_tenant uuid, p_start timestamptz, p_end timestamptz)
returns text
language sql
as $$
    select outcome from public.apply_subscription_payment(
        'sub_TESTA', p_tenant, 'active', 2, p_start, p_end,
        p_payment_id, 'inv_TESTA', 99800, 'INR', 'upi', 2355, 359, 'https://rzp.io/i/test', now()
    );
$$;

-- ===========================================================================
-- 1. Mapping a payment to a tenant
-- ===========================================================================
select is(
    (select outcome from public.apply_subscription_payment(
        'sub_NOTOURS', '10000000-0000-0000-0000-00000000000a', 'active', 2, now(), now() + interval '30 days',
        'pay_X1', null, 100, 'INR', 'upi', null, null, null, now())),
    'SUBSCRIPTION_UNKNOWN',
    'A subscription not started from our app is never mapped to a tenant'
);

select is(
    tests.pay_a('pay_X2', '10000000-0000-0000-0000-00000000000b', now(), now() + interval '30 days'),
    'TENANT_MISMATCH',
    'notes.tenant_id disagreeing with the recorded tenant grants nothing'
);

select is(
    (select count(*)::int from public.billing_payments),
    0,
    'Refused payments write no receipt'
);

select is(
    tests.pay_a('pay_A1', '10000000-0000-0000-0000-00000000000a', now(), now() + interval '30 days'),
    'APPLIED',
    'A matching payment is applied'
);

select ok(
    (select subscription_status = 'active'
            and current_period_ends_at > now() + interval '29 days'
            and active_billing_subscription_id = '30000000-0000-0000-0000-00000000000a'
     from public.tenants_subscriptions where tenant_id = '10000000-0000-0000-0000-00000000000a'),
    'Tenant A becomes active until the paid period end, pointing at its subscription'
);

select ok(
    private.has_crm_access('10000000-0000-0000-0000-00000000000a'),
    'The unchanged access predicate now grants Tenant A access'
);

-- ===========================================================================
-- 2. Idempotency and "access only moves forward"
-- ===========================================================================
select is(
    tests.pay_a('pay_A1', '10000000-0000-0000-0000-00000000000a', now(), now() + interval '30 days'),
    'ALREADY_APPLIED',
    'Redelivering the same payment is recognised'
);

select is(
    (select count(*)::int from public.billing_payments where razorpay_payment_id = 'pay_A1'),
    1,
    'A redelivered payment never writes a second receipt'
);

do $$ begin perform tests.pay_a('pay_A0_OLD', '10000000-0000-0000-0000-00000000000a', now() - interval '60 days', now() - interval '30 days'); end $$;

select ok(
    (select current_period_ends_at > now() + interval '29 days'
     from public.tenants_subscriptions where tenant_id = '10000000-0000-0000-0000-00000000000a'),
    'A late, older payment never shortens access'
);

update public.tenants_subscriptions
set subscription_status = 'blocked', current_period_ends_at = now() - interval '1 day'
where tenant_id = '10000000-0000-0000-0000-00000000000a';

do $$ begin perform tests.pay_a('pay_A2', '10000000-0000-0000-0000-00000000000a', now(), now() + interval '30 days'); end $$;

select is(
    (select subscription_status from public.tenants_subscriptions where tenant_id = '10000000-0000-0000-0000-00000000000a'),
    'active',
    'Paying after being blocked by the reconciliation cron revives access'
);

-- ===========================================================================
-- 3. Seats: trial companies cannot invite; paid companies up to their seats (owner uses one)
-- ===========================================================================
select is(
    (select outcome from public.create_member_invitation(
        '10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'someone@example.com', 'employee')),
    'PLAN_REQUIRED',
    'A trial company cannot invite members'
);

select is(
    (select outcome from public.create_member_invitation(
        '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'first@example.com', 'employee')),
    'CREATED',
    'A paid company with a free seat can invite'
);

select is(
    (select outcome from public.create_member_invitation(
        '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'second@example.com', 'employee')),
    'SEAT_LIMIT_REACHED',
    'Owner + one pending invitation fill 2 seats, so a further invite is refused'
);

-- Fill the second seat with a real member, then check the join-time guard directly.
update public.invitation_member set status = 'revoked' where tenant_id = '10000000-0000-0000-0000-00000000000a';
insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status) values
    ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000e', 'employee', 'active');

select throws_ok(
    $$ select private.assert_seat_available('10000000-0000-0000-0000-00000000000a') $$,
    'BL002',
    null,
    'Joining a company whose seats are all taken is refused'
);

select throws_ok(
    $$ select private.assert_seat_available('10000000-0000-0000-0000-00000000000b') $$,
    'BL001',
    null,
    'Joining a trial company through an old invitation is refused'
);

-- ===========================================================================
-- 4. Isolation: billing rows are visible to the tenant's owner only
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-00000000000a');

select ok(
    (select count(*)::int from public.billing_payments) > 0
    and (select count(*)::int from public.billing_subscriptions where tenant_id = '10000000-0000-0000-0000-00000000000b') = 0,
    'Owner A sees their own receipts and none of Tenant B''s subscriptions'
);

select throws_ok(
    $$ select * from public.billing_webhook_events $$,
    '42501',
    null,
    'No signed-in user can read the webhook log (it holds customer PII)'
);

reset role;

select tests.authenticate_as('00000000-0000-0000-0000-00000000000e');

select is(
    (select count(*)::int from public.billing_payments),
    0,
    'An employee cannot read the company''s receipts'
);

reset role;

select * from finish();

rollback;
