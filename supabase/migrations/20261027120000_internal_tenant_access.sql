-- Internal company access: AgentzPro's own company uses the CRM without paying.
--
-- A tenant marked is_internal gets CRM access (evaluateCrmAccess), invite seats up to
-- internal_seat_limit (tenant_seat_usage), and is never blocked by the hourly reconciliation.
-- Every other tenant keeps the normal rules: trial, then a paid plan, then seats.
--
-- Nothing here marks any tenant. The flag is set only by hand, by tenant_id, with a service-role
-- SQL update. authenticated has select-only on tenants_subscriptions, and the one client-callable
-- writer (complete_owner_onboarding) inserts a fixed column list, so a new tenant always gets false.
--
-- tenant_seat_usage and reconcile_tenant_subscriptions keep their signatures. Each body is copied from
-- the live production definition (pg_get_functiondef, 2026-10-27), with only the internal branch added.

begin;

alter table public.tenants_subscriptions
    add column is_internal boolean not null default false,
    add column internal_seat_limit integer,
    add constraint tenants_subscriptions_internal_seat_limit_check
        check (
            (is_internal and internal_seat_limit is not null and internal_seat_limit between 1 and 500)
            or (not is_internal and internal_seat_limit is null)
        );

-- ---------------------------------------------------------------------------
-- tenant_seat_usage — an internal tenant counts as paid, with internal_seat_limit seats.
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
        coalesce(ts.is_internal or (ts.subscription_status = 'active' and ts.current_period_ends_at > now()), false) as is_paid,
        case
            when ts.is_internal then ts.internal_seat_limit
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
-- reconcile_tenant_subscriptions — never blocks an internal tenant.
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
        where not is_internal
          and (
            (subscription_status = 'trialing' and trial_ends_at <= now())
            or
            (subscription_status = 'active' and current_period_ends_at <= now())
          )
        returning tenant_subscription_id
    )
    select count(*) into v_updated_count from expired;

    return v_updated_count;
end;
$$;

revoke all on function public.reconcile_tenant_subscriptions() from public, anon, authenticated;
grant execute on function public.reconcile_tenant_subscriptions() to service_role;

commit;
