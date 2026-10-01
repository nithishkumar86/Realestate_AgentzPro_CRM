-- MVP: the owner blocks and enables employees instead of removing them. Nothing is deleted — only
-- tenant_memberships.membership_status changes between 'active' and 'blocked' (both already allowed
-- by its check constraint), so a wrong click can always be undone.
--
-- Seats count only 'active' members (tenant_seat_usage), so blocking frees a seat and enabling needs
-- one, using the same rule as create_member_invitation: active members + pending invitations must be
-- below the paid seats.
--
-- remove_tenant_member stays in the database unused; removal and re-invitation return in v1.

begin;

create or replace function public.set_tenant_member_access(
    p_tenant_id uuid,
    p_owner_user_id uuid,
    p_member_user_id uuid,
    p_membership_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_current_status text;
    v_usage record;
begin
    if p_membership_status not in ('active', 'blocked') then
        return 'INVALID_STATUS';
    end if;

    if not exists (
        select 1
        from public.tenant_memberships as owner_membership
        where owner_membership.tenant_id = p_tenant_id
          and owner_membership.user_id = p_owner_user_id
          and owner_membership.membership_role = 'owner'
          and owner_membership.membership_status = 'active'
    ) then
        raise exception 'Only the active tenant owner can change member access' using errcode = '42501';
    end if;

    -- Same lock as create_member_invitation, so an enable and an invite cannot both take the last seat.
    perform 1
    from public.tenants_subscriptions as ts
    where ts.tenant_id = p_tenant_id
    for update;

    select tm.membership_status into v_current_status
    from public.tenant_memberships as tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_member_user_id
      and tm.membership_role = 'employee'
    for update;

    if v_current_status is null then
        return 'NOT_FOUND';
    end if;

    if v_current_status = p_membership_status then
        return 'UPDATED';
    end if;

    if p_membership_status = 'active' then
        select * into v_usage from public.tenant_seat_usage(p_tenant_id);

        if v_usage.is_paid is not true
           or v_usage.active_members + v_usage.pending_invitations >= coalesce(v_usage.paid_seats, 0) then
            return 'NO_SEAT';
        end if;
    end if;

    update public.tenant_memberships as tm
    set membership_status = p_membership_status
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_member_user_id
      and tm.membership_role = 'employee';

    return 'UPDATED';
end;
$$;

revoke all on function public.set_tenant_member_access(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_tenant_member_access(uuid, uuid, uuid, text) to service_role;

commit;
