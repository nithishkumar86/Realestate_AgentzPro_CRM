-- Invitations grant 'employee' only.
--
-- tenant_memberships.membership_role allows just 'owner' and 'employee' (20260923152600), but
-- invitation_member.membership_role and create_member_invitation still accepted 'admin'. An owner
-- calling the API directly could therefore record an admin invitation that holds a paid seat and
-- can never be accepted: the membership insert violates its check constraint and the invitee only
-- sees a generic failure. Close the gap at every layer: existing rows, the constraint, and the RPC.
begin;

-- Any admin invitation is one the invitee could never have accepted as 'admin'; make it the role
-- the membership table can actually hold, so an open one stays acceptable.
update public.invitation_member
set membership_role = 'employee'
where membership_role = 'admin';

alter table public.invitation_member drop constraint invitation_member_membership_role_check;
alter table public.invitation_member add constraint invitation_member_membership_role_check
    check (membership_role = 'employee');

-- create_member_invitation — identical to 20260926120000_billing_razorpay.sql except that the role
-- check now accepts 'employee' only.
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

commit;
