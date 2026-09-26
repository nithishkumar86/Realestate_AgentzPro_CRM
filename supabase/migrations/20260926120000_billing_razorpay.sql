-- Razorpay subscription billing (v1).
--
-- How money becomes CRM access:
--   1. An owner starts checkout in our app. The server creates a Razorpay subscription
--      (notes.tenant_id = the owner's active tenant) and records it in billing_subscriptions BEFORE
--      the browser opens Razorpay Checkout. That row is what maps every later payment to a tenant.
--   2. Razorpay sends `payment.captured` (the only webhook event we subscribe to). The server verifies
--      the signature, logs the event once in billing_webhook_events, looks up invoice -> subscription
--      through the Razorpay API, and calls apply_subscription_payment().
--   3. apply_subscription_payment() writes the receipt (billing_payments) and moves
--      tenants_subscriptions.current_period_ends_at forward. Access itself is still decided only by
--      evaluateCrmAccess() / private.has_crm_access(), which are unchanged: no payment, no new date,
--      and access lapses on its own.
--
-- Seats: Razorpay `quantity` = seats. Trial companies cannot invite; a paid company can invite up to
-- its seat count (the owner uses one seat). Enforced here, inside the invitation RPCs, so no code path
-- can skip it.
--
-- billing_plans rows are NOT inserted here: test-mode and live-mode Razorpay plan ids differ. After
-- creating the plans in the Razorpay Dashboard, insert them per environment, e.g.:
--
--   insert into public.billing_plans
--       (plan_code, plan_name, tier, billing_period, razorpay_plan_id, price_per_seat_paise, total_count)
--   values
--       ('pro_monthly', 'Pro Monthly', 'pro', 'monthly', 'plan_XXXXXXXXXXXXXX', 49900, 120),
--       ('pro_yearly',  'Pro Yearly',  'pro', 'yearly',  'plan_YYYYYYYYYYYYYY', 499000, 10);

-- ---------------------------------------------------------------------------
-- billing_plans — the price list. One row per Razorpay plan.
-- ---------------------------------------------------------------------------
create table public.billing_plans (
    billing_plan_id uuid primary key default gen_random_uuid(),
    plan_code text not null check (plan_code ~ '^[a-z0-9_]{2,40}$'),
    plan_name text not null check (length(btrim(plan_name)) between 1 and 80),
    tier text not null check (tier in ('pro', 'max')),
    billing_period text not null check (billing_period in ('monthly', 'yearly')),
    razorpay_plan_id text not null check (razorpay_plan_id ~ '^plan_[A-Za-z0-9]+$'),
    -- Money is stored as whole paise, never as a decimal rupee amount.
    price_per_seat_paise integer not null check (price_per_seat_paise > 0),
    currency text not null default 'INR' check (currency = 'INR'),
    -- Razorpay requires total_count (or end_at) when creating a subscription.
    total_count integer not null check (total_count > 0),
    -- Retired prices are hidden, never deleted: existing subscriptions still point at them.
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint billing_plans_plan_code_key unique (plan_code),
    constraint billing_plans_razorpay_plan_id_key unique (razorpay_plan_id)
);

-- ---------------------------------------------------------------------------
-- billing_subscriptions — one row per Razorpay subscription (sub_…). A tenant collects many over
-- time (abandoned checkouts, cancel and come back), so this is not one-per-tenant.
-- ---------------------------------------------------------------------------
create table public.billing_subscriptions (
    billing_subscription_id uuid primary key default gen_random_uuid(),
    -- restrict, not cascade: money records must never disappear with a tenant.
    tenant_id uuid not null references public.tenants (tenant_id) on delete restrict,
    billing_plan_id uuid not null references public.billing_plans (billing_plan_id) on delete restrict,
    razorpay_subscription_id text not null check (razorpay_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
    seat_quantity integer not null check (seat_quantity > 0),
    -- Razorpay's own lifecycle (razorpay.com/docs/payments/subscriptions/states/).
    razorpay_status text not null default 'created'
        check (razorpay_status in (
            'created', 'authenticated', 'active', 'pending', 'halted',
            'cancelled', 'completed', 'expired', 'paused'
        )),
    current_period_start timestamptz,
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    created_by_user_id uuid not null references auth.users (id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint billing_subscriptions_razorpay_subscription_id_key unique (razorpay_subscription_id),
    constraint billing_subscriptions_period_order
        check (current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);

create index billing_subscriptions_tenant_idx
    on public.billing_subscriptions (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- billing_payments — the receipt book. Append-only: one row per captured Razorpay payment.
-- ---------------------------------------------------------------------------
create table public.billing_payments (
    billing_payment_id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants (tenant_id) on delete restrict,
    billing_subscription_id uuid not null
        references public.billing_subscriptions (billing_subscription_id) on delete restrict,
    razorpay_payment_id text not null check (razorpay_payment_id ~ '^pay_[A-Za-z0-9]+$'),
    razorpay_invoice_id text check (razorpay_invoice_id is null or razorpay_invoice_id ~ '^inv_[A-Za-z0-9]+$'),
    amount_paise integer not null check (amount_paise > 0),
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    payment_method text,
    fee_paise integer check (fee_paise is null or fee_paise >= 0),
    tax_paise integer check (tax_paise is null or tax_paise >= 0),
    period_start timestamptz not null,
    period_end timestamptz not null,
    invoice_url text,
    paid_at timestamptz not null,
    created_at timestamptz not null default now(),
    -- A payment can never be recorded twice, whatever the webhook code does.
    constraint billing_payments_razorpay_payment_id_key unique (razorpay_payment_id),
    constraint billing_payments_period_order check (period_end > period_start)
);

create index billing_payments_tenant_paid_idx
    on public.billing_payments (tenant_id, paid_at desc);

create index billing_payments_subscription_idx
    on public.billing_payments (billing_subscription_id);

-- ---------------------------------------------------------------------------
-- billing_webhook_events — every Razorpay delivery, once. Duplicate guard + debugging log.
-- Holds the raw payload (customer email / phone), so no user role can read it.
-- ---------------------------------------------------------------------------
create table public.billing_webhook_events (
    billing_webhook_event_id uuid primary key default gen_random_uuid(),
    -- The x-razorpay-event-id header: unique per event, repeated on redelivery.
    razorpay_event_id text not null check (length(razorpay_event_id) between 1 and 200),
    event_type text not null check (length(event_type) between 1 and 100),
    razorpay_payment_id text,
    processing_status text not null default 'received'
        check (processing_status in ('received', 'processed', 'ignored', 'failed')),
    processing_error text,
    payload jsonb not null,
    received_at timestamptz not null default now(),
    processed_at timestamptz,
    constraint billing_webhook_events_razorpay_event_id_key unique (razorpay_event_id)
);

create index billing_webhook_events_payment_idx
    on public.billing_webhook_events (razorpay_payment_id)
    where razorpay_payment_id is not null;

-- ---------------------------------------------------------------------------
-- tenants_subscriptions — the access card gains a pointer to the subscription paying for it.
-- ---------------------------------------------------------------------------
alter table public.tenants_subscriptions
    add column active_billing_subscription_id uuid
        references public.billing_subscriptions (billing_subscription_id) on delete set null;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger set_billing_plans_updated_at
    before update on public.billing_plans
    for each row execute function public.set_updated_at();

create trigger set_billing_subscriptions_updated_at
    before update on public.billing_subscriptions
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security. The app reads through the service role; these policies are the backstop.
-- ---------------------------------------------------------------------------
alter table public.billing_plans enable row level security;
alter table public.billing_plans force row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_subscriptions force row level security;
alter table public.billing_payments enable row level security;
alter table public.billing_payments force row level security;
alter table public.billing_webhook_events enable row level security;
alter table public.billing_webhook_events force row level security;

revoke all on table public.billing_plans from public, anon, authenticated;
revoke all on table public.billing_subscriptions from public, anon, authenticated;
revoke all on table public.billing_payments from public, anon, authenticated;
revoke all on table public.billing_webhook_events from public, anon, authenticated;

-- The price list is not secret: any signed-in user may read the active plans.
grant select on table public.billing_plans to authenticated;
create policy billing_plans_select_active on public.billing_plans
    for select
    to authenticated
    using (is_active);

-- Billing history belongs to the tenant's owner only, never to employees or other tenants.
grant select on table public.billing_subscriptions to authenticated;
create policy billing_subscriptions_select_owner on public.billing_subscriptions
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.tenant_memberships as membership
            where membership.tenant_id = billing_subscriptions.tenant_id
              and membership.user_id = (select auth.uid())
              and membership.membership_role = 'owner'
              and membership.membership_status = 'active'
        )
    );

grant select on table public.billing_payments to authenticated;
create policy billing_payments_select_owner on public.billing_payments
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.tenant_memberships as membership
            where membership.tenant_id = billing_payments.tenant_id
              and membership.user_id = (select auth.uid())
              and membership.membership_role = 'owner'
              and membership.membership_status = 'active'
        )
    );

-- billing_webhook_events: no grant, no policy — service role only.

grant select, insert, update on table public.billing_plans to service_role;
grant select, insert, update on table public.billing_subscriptions to service_role;
grant select, insert on table public.billing_payments to service_role;
grant select, insert, update on table public.billing_webhook_events to service_role;

-- ---------------------------------------------------------------------------
-- tenant_seat_usage — seats paid vs. seats used for one tenant.
-- `is_paid` is true only while a paid period is actually running; `paid_seats` is null otherwise.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_seat_usage(p_tenant_id uuid)
returns table (
    is_paid boolean,
    paid_seats integer,
    active_members integer,
    pending_invitations integer
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        coalesce(ts.subscription_status = 'active' and ts.current_period_ends_at > now(), false) as is_paid,
        case
            when ts.subscription_status = 'active' and ts.current_period_ends_at > now() then bs.seat_quantity
            else null
        end as paid_seats,
        (
            select count(*)::integer
            from public.tenant_memberships as tm
            where tm.tenant_id = p_tenant_id
              and tm.membership_status = 'active'
        ) as active_members,
        (
            select count(*)::integer
            from public.invitation_member as im
            where im.tenant_id = p_tenant_id
              and im.status = 'pending'
              and im.expires_at > now()
        ) as pending_invitations
    from public.tenants_subscriptions as ts
    left join public.billing_subscriptions as bs
        on bs.billing_subscription_id = ts.active_billing_subscription_id
    where ts.tenant_id = p_tenant_id;
$$;

revoke all on function public.tenant_seat_usage(uuid) from public, anon, authenticated;
grant execute on function public.tenant_seat_usage(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- apply_subscription_payment — the only writer of paid access. One transaction: receipt, subscription
-- state, and the tenant's access card change together or not at all.
--
-- Outcomes:
--   APPLIED               receipt written, access extended
--   ALREADY_APPLIED       this payment id was recorded before; state re-applied idempotently
--   SUBSCRIPTION_UNKNOWN  no billing_subscriptions row for this sub_… (not started from our app)
--   TENANT_MISMATCH       notes.tenant_id disagrees with the tenant we recorded at checkout
-- ---------------------------------------------------------------------------
create or replace function public.apply_subscription_payment(
    p_razorpay_subscription_id text,
    p_notes_tenant_id uuid,
    p_razorpay_status text,
    p_seat_quantity integer,
    p_period_start timestamptz,
    p_period_end timestamptz,
    p_razorpay_payment_id text,
    p_razorpay_invoice_id text,
    p_amount_paise integer,
    p_currency text,
    p_payment_method text,
    p_fee_paise integer,
    p_tax_paise integer,
    p_invoice_url text,
    p_paid_at timestamptz
)
returns table (
    outcome text,
    tenant_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_subscription public.billing_subscriptions%rowtype;
    v_inserted_payment_id uuid;
begin
    if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
        raise exception 'A valid billing period is required' using errcode = '22023';
    end if;

    select bs.* into v_subscription
    from public.billing_subscriptions as bs
    where bs.razorpay_subscription_id = p_razorpay_subscription_id
    for update;

    if v_subscription.billing_subscription_id is null then
        return query select 'SUBSCRIPTION_UNKNOWN'::text, null::uuid;
        return;
    end if;

    -- Two independent records must agree before money turns into access.
    if p_notes_tenant_id is null or p_notes_tenant_id <> v_subscription.tenant_id then
        return query select 'TENANT_MISMATCH'::text, v_subscription.tenant_id;
        return;
    end if;

    insert into public.billing_payments (
        tenant_id, billing_subscription_id, razorpay_payment_id, razorpay_invoice_id,
        amount_paise, currency, payment_method, fee_paise, tax_paise,
        period_start, period_end, invoice_url, paid_at
    )
    values (
        v_subscription.tenant_id, v_subscription.billing_subscription_id, p_razorpay_payment_id, p_razorpay_invoice_id,
        p_amount_paise, p_currency, p_payment_method, p_fee_paise, p_tax_paise,
        p_period_start, p_period_end, p_invoice_url, p_paid_at
    )
    on conflict on constraint billing_payments_razorpay_payment_id_key do nothing
    returning billing_payments.billing_payment_id into v_inserted_payment_id;

    -- Only ever move the period forward: a late redelivery of an older payment must not rewind it.
    update public.billing_subscriptions as bs
    set razorpay_status = p_razorpay_status,
        seat_quantity = p_seat_quantity,
        current_period_start = case
            when bs.current_period_end is null or p_period_end >= bs.current_period_end then p_period_start
            else bs.current_period_start
        end,
        current_period_end = greatest(coalesce(bs.current_period_end, p_period_end), p_period_end)
    where bs.billing_subscription_id = v_subscription.billing_subscription_id;

    -- 'blocked' is revived too: the hourly reconciliation sets active -> blocked once a period ends,
    -- and an owner who pays after that must get straight back in.
    update public.tenants_subscriptions as ts
    set subscription_status = 'active',
        current_period_started_at = case
            when ts.current_period_ends_at is null or p_period_end >= ts.current_period_ends_at then p_period_start
            else ts.current_period_started_at
        end,
        current_period_ends_at = greatest(coalesce(ts.current_period_ends_at, p_period_end), p_period_end),
        active_billing_subscription_id = v_subscription.billing_subscription_id
    where ts.tenant_id = v_subscription.tenant_id;

    if not found then
        raise exception 'Tenant subscription row is missing' using errcode = 'P0002';
    end if;

    return query select
        (case when v_inserted_payment_id is null then 'ALREADY_APPLIED' else 'APPLIED' end)::text,
        v_subscription.tenant_id;
end;
$$;

revoke all on function public.apply_subscription_payment(
    text, uuid, text, integer, timestamptz, timestamptz, text, text, integer, text, text, integer, integer, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_subscription_payment(
    text, uuid, text, integer, timestamptz, timestamptz, text, text, integer, text, text, integer, integer, text, timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- private.assert_seat_available — shared join-time seat check for the two accept paths.
-- Locks the tenant's access row so two invitees accepting at once cannot both take the last seat.
-- ---------------------------------------------------------------------------
create or replace function private.assert_seat_available(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_usage record;
begin
    perform 1
    from public.tenants_subscriptions as ts
    where ts.tenant_id = p_tenant_id
    for update;

    select * into v_usage from public.tenant_seat_usage(p_tenant_id);

    -- Own SQLSTATEs (class BL = billing): P0001/P0002 already mean other things to the callers.
    if v_usage.is_paid is not true then
        raise exception 'This company needs a paid plan before members can join' using errcode = 'BL001';
    end if;

    if v_usage.active_members >= coalesce(v_usage.paid_seats, 0) then
        raise exception 'This company has no free seats' using errcode = 'BL002';
    end if;
end;
$$;

revoke all on function private.assert_seat_available(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_member_invitation — unchanged from 20260924120000_multi_membership.sql except for the seat
-- check right before the insert. A pending invitation holds a seat, so paid seats bound
-- (active members + pending invitations).
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
    v_usage record;
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

    -- Seats. The row lock serialises concurrent invites for this tenant, so two requests cannot both
    -- take the last seat.
    perform 1
    from public.tenants_subscriptions as ts
    where ts.tenant_id = p_tenant_id
    for update;

    select * into v_usage from public.tenant_seat_usage(p_tenant_id);

    if v_usage.is_paid is not true then
        return query select 'PLAN_REQUIRED'::text, null::uuid, v_existing_user_id;
        return;
    end if;

    if v_usage.active_members + v_usage.pending_invitations >= coalesce(v_usage.paid_seats, 0) then
        return query select 'SEAT_LIMIT_REACHED'::text, null::uuid, v_existing_user_id;
        return;
    end if;

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
-- accept_member_invitation — unchanged except for the join-time seat check before the membership
-- insert (defence in depth: the company may have lapsed since the invitation was sent).
-- ---------------------------------------------------------------------------
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

    perform private.assert_seat_available(v_invitation.tenant_id);

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
-- join_invited_workspace — unchanged except for the same join-time seat check.
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

    perform private.assert_seat_available(v_invitation.tenant_id);

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
