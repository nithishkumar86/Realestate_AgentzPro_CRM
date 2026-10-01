-- Turns the paid-plan and seat checks for invitations back on (undoes
-- 20261001120000_pause_invite_plan_check.sql). Run this once payments work.
-- The function bodies are exactly those of 20261001100000_one_to_one_membership.sql and
-- 20260926120000_billing_razorpay.sql.

begin;

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

    if p_membership_role is distinct from 'employee' then
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

    if v_existing_user_id is not null and exists (
        select 1
        from public.tenant_memberships as tm
        where tm.tenant_id = p_tenant_id
          and tm.user_id = v_existing_user_id
    ) then
        return query select 'ALREADY_MEMBER'::text, null::uuid, v_existing_user_id;
        return;
    end if;

    -- One login, one company: anyone who has completed account setup (owner or employee of any
    -- company, or removed from one) cannot be invited. An auth.users row without a profile is only an
    -- unfinished sign-up or an unaccepted invite, so it does not count.
    if v_existing_user_id is not null and exists (
        select 1
        from public.profiles as p
        where p.user_id = v_existing_user_id
    ) then
        return query select 'HAS_ACCOUNT'::text, null::uuid, v_existing_user_id;
        return;
    end if;

    update public.invitation_member as im
    set status = 'expired'
    where im.email = v_email
      and im.status = 'pending'
      and im.expires_at <= now();

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

commit;
