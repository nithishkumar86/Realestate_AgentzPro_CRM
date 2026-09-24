-- Regression for supabase/migrations/20260922120000_invitation_member.sql as changed by
-- 20260924120000_multi_membership.sql (one person, many companies).
--
-- Runs entirely inside one DO block that ALWAYS ends by raising, so every fixture row (auth users,
-- tenants, memberships, invitations) is rolled back. A passing run raises
--   'MEMBER_INVITATION_REGRESSION_PASSED ...'
-- and any failed assertion raises 'ASSERTION FAILED: ...' instead.
do $$
declare
    v_owner uuid := gen_random_uuid();
    v_invitee uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();
    v_other_owner uuid := gen_random_uuid();
    v_tenant uuid;
    v_other_tenant uuid;
    v_row record;
    v_tenants_before bigint;
    v_subscriptions_before bigint;
    v_invitation_id uuid;
    v_other_invitation_id uuid;
    v_outsider_invitation_id uuid;
    v_first_owned uuid;
    v_failed boolean;

begin
    insert into auth.users (id, instance_id, aud, role, email)
    values
        (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-owner@invite.test'),
        (v_invitee, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-invitee@invite.test'),
        (v_outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-outsider@invite.test'),
        (v_other_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-other-owner@invite.test');

    insert into public.tenants (tenant_name, timezone) values ('Regression Co', 'Asia/Kolkata') returning tenant_id into v_tenant;
    insert into public.tenants (tenant_name, timezone) values ('Other Co', 'Asia/Kolkata') returning tenant_id into v_other_tenant;
    insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_tenant, v_owner, 'owner');
    insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_other_tenant, v_other_owner, 'owner');
    insert into public.tenants_subscriptions (tenant_id) values (v_tenant), (v_other_tenant);
    insert into public.profiles (user_id, full_name, phone_number, professional_role)
    values (v_other_owner, 'Other Owner', '919876543210', 'Director');

    -- 1. The owner role can never be granted by invitation.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'x@invite.test', 'owner');
    if v_row.outcome <> 'INVALID_ROLE' then raise exception 'ASSERTION FAILED: owner role accepted (%)', v_row.outcome; end if;

    -- 2. Only the tenant's owner can invite.
    select * into v_row from public.create_member_invitation(v_tenant, v_other_owner, 'x@invite.test', 'employee');
    if v_row.outcome <> 'NOT_OWNER' then raise exception 'ASSERTION FAILED: non-owner could invite (%)', v_row.outcome; end if;

    -- 3. A member of ANOTHER company can be invited (multi-membership) and carries their user id.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'REGR-other-owner@invite.test', 'employee');
    if v_row.outcome <> 'CREATED' or v_row.user_id is distinct from v_other_owner then
        raise exception 'ASSERTION FAILED: member of another company not invitable (%, %)', v_row.outcome, v_row.user_id;
    end if;
    v_other_invitation_id := v_row.invitation_id;

    -- 4. A member of THIS company cannot be invited again.
    select * into v_row from public.create_member_invitation(v_other_tenant, v_other_owner, 'regr-other-owner@invite.test', 'employee');
    if v_row.outcome <> 'ALREADY_MEMBER' then raise exception 'ASSERTION FAILED: same-tenant member invited (%)', v_row.outcome; end if;

    -- 5. A valid invitation is recorded with the existing auth user id and the chosen role.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, '  Regr-Invitee@Invite.test ', 'employee');
    if v_row.outcome <> 'CREATED' or v_row.user_id is distinct from v_invitee then
        raise exception 'ASSERTION FAILED: invitation not created correctly (%, %)', v_row.outcome, v_row.user_id;
    end if;
    v_invitation_id := v_row.invitation_id;

    -- 6. One open invitation per email PER COMPANY; a second company may invite the same person.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'ALREADY_INVITED' then raise exception 'ASSERTION FAILED: duplicate invite (%)', v_row.outcome; end if;
    select * into v_row from public.create_member_invitation(v_other_tenant, v_other_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'CREATED' then raise exception 'ASSERTION FAILED: cross-tenant invite blocked (%)', v_row.outcome; end if;

    -- 7. A user cannot accept an invitation addressed to someone else.
    perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'email', 'regr-outsider@invite.test', 'role', 'authenticated')::text, true);
    v_failed := false;
    begin
        perform public.accept_member_invitation(v_invitation_id, 'Outsider', '919876543210', 'Sales');
    exception when sqlstate 'P0002' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: outsider accepted someone else''s invitation'; end if;

    -- 8. The invitee joins the OWNER'S tenant with the OWNER'S role; no tenant or subscription is created.
    select count(*) into v_tenants_before from public.tenants;
    select count(*) into v_subscriptions_before from public.tenants_subscriptions;

    perform set_config('request.jwt.claims', json_build_object('sub', v_invitee, 'email', 'regr-invitee@invite.test', 'role', 'authenticated')::text, true);
    select * into v_row from public.accept_member_invitation(v_invitation_id, 'Ravi Invitee', '919876543210', 'Sales Executive');

    if v_row.tenant_id <> v_tenant or v_row.membership_role <> 'employee' then
        raise exception 'ASSERTION FAILED: accepted into wrong tenant/role (%, %)', v_row.tenant_id, v_row.membership_role;
    end if;
    if (select count(*) from public.tenants) <> v_tenants_before
        or (select count(*) from public.tenants_subscriptions) <> v_subscriptions_before then
        raise exception 'ASSERTION FAILED: accepting an invitation created a tenant or subscription';
    end if;
    if not exists (select 1 from public.profiles where user_id = v_invitee and full_name = 'Ravi Invitee') then
        raise exception 'ASSERTION FAILED: profile row missing';
    end if;
    if (select status from public.invitation_member where invitation_id = v_invitation_id) <> 'accepted' then
        raise exception 'ASSERTION FAILED: invitation not marked accepted';
    end if;

    -- 9. Accepting twice is idempotent: same tenant, still exactly one membership there.
    select * into v_row from public.accept_member_invitation(v_invitation_id, 'Ravi Invitee', '919876543210', 'Sales Executive');
    if v_row.tenant_id <> v_tenant or (select count(*) from public.tenant_memberships where user_id = v_invitee) <> 1 then
        raise exception 'ASSERTION FAILED: second accept was not idempotent';
    end if;

    -- 10. One-click join of the second company: SAME user id, two memberships, one profile untouched.
    select invitation_id into v_row from public.invitation_member
    where tenant_id = v_other_tenant and email = 'regr-invitee@invite.test' and status = 'pending';
    select * into v_row from public.join_invited_workspace(v_row.invitation_id);
    if v_row.tenant_id <> v_other_tenant then raise exception 'ASSERTION FAILED: join went to wrong tenant'; end if;
    if (select count(*) from public.tenant_memberships where user_id = v_invitee) <> 2 then
        raise exception 'ASSERTION FAILED: expected 2 memberships for one user';
    end if;
    if (select count(*) from public.profiles where user_id = v_invitee) <> 1
        or (select professional_role from public.profiles where user_id = v_invitee) <> 'Sales Executive' then
        raise exception 'ASSERTION FAILED: join changed the shared profile';
    end if;

    -- 11. join_invited_workspace refuses someone with no profile (they must use the setup form).
    perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'email', 'regr-outsider@invite.test', 'role', 'authenticated')::text, true);
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-outsider@invite.test', 'employee');
    v_outsider_invitation_id := v_row.invitation_id;
    v_failed := false;
    begin
        perform public.join_invited_workspace(v_outsider_invitation_id);
    exception when sqlstate 'P0001' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: profile-less user joined with one click'; end if;

    -- 12. Decline: only the invitee's own pending invitation, and it leaves the owner's pending list.
    if not public.decline_member_invitation(v_outsider_invitation_id) then
        raise exception 'ASSERTION FAILED: decline did not apply';
    end if;
    if (select status from public.invitation_member where invitation_id = v_outsider_invitation_id) <> 'declined' then
        raise exception 'ASSERTION FAILED: invitation not marked declined';
    end if;
    if public.decline_member_invitation(v_other_invitation_id) then
        raise exception 'ASSERTION FAILED: declined someone else''s invitation';
    end if;

    -- 13. An expired invitation cannot be accepted, and does not block a fresh one.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-outsider@invite.test', 'employee');
    update public.invitation_member set expires_at = now() - interval '1 minute' where invitation_id = v_row.invitation_id;
    v_failed := false;
    begin
        perform public.accept_member_invitation(v_row.invitation_id, 'Outsider', '919876543210', 'Sales');
    exception when sqlstate 'P0002' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: expired invitation accepted'; end if;
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-outsider@invite.test', 'employee');
    if v_row.outcome <> 'CREATED' then raise exception 'ASSERTION FAILED: expired invite blocked a new one (%)', v_row.outcome; end if;

    -- 14. The table can't hold an owner-role invitation even when written directly.
    v_failed := false;
    begin
        insert into public.invitation_member (tenant_id, email, membership_role, invited_by)
        values (v_tenant, 'direct@invite.test', 'owner', v_owner);
    exception when check_violation then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: owner-role row inserted directly'; end if;

    -- 15. Create new company: an employee-only person gets one owned company; a second call returns it.
    perform set_config('request.jwt.claims', json_build_object('sub', v_invitee, 'email', 'regr-invitee@invite.test', 'role', 'authenticated')::text, true);
    select count(*) into v_tenants_before from public.tenants;
    select * into v_row from public.create_owned_workspace('Ravi Realty', 'Asia/Kolkata');
    if v_row.subscription_status <> 'trialing'
        or not exists (select 1 from public.tenant_memberships where tenant_id = v_row.tenant_id and user_id = v_invitee and membership_role = 'owner')
    then
        raise exception 'ASSERTION FAILED: create_owned_workspace did not make the caller owner';
    end if;
    v_first_owned := v_row.tenant_id;
    select * into v_row from public.create_owned_workspace('Ravi Realty Two', 'Asia/Kolkata');
    if v_row.tenant_id <> v_first_owned or (select count(*) from public.tenants) <> v_tenants_before + 1 then
        raise exception 'ASSERTION FAILED: a second owned company was created';
    end if;

    -- 16. The DB itself refuses a second owner membership for one person.
    v_failed := false;
    begin
        insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_tenant, v_other_owner, 'owner');
    exception when unique_violation then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: person owns two tenants'; end if;

    -- 17. First-time onboarding by someone who is only an employee elsewhere must not return the
    --     employer's tenant as their own (it returns the tenant they OWN, from step 15).
    select * into v_row from public.complete_owner_onboarding('Ravi Invitee', '919876543210', 'Ignored Co', 'Sales Executive', 'Asia/Kolkata');
    if v_row.tenant_id in (v_tenant, v_other_tenant) then
        raise exception 'ASSERTION FAILED: onboarding returned an employer tenant';
    end if;

    -- 18. Removal from one company keeps the profile and the other memberships, deletes that
    --     company's invitation rows, and writes an audit row.
    if not public.remove_tenant_member(v_tenant, v_owner, v_invitee) then
        raise exception 'ASSERTION FAILED: removal did not apply';
    end if;
    if exists (select 1 from public.tenant_memberships where tenant_id = v_tenant and user_id = v_invitee) then
        raise exception 'ASSERTION FAILED: membership still present after removal';
    end if;
    if (select count(*) from public.tenant_memberships where user_id = v_invitee) <> 2 then
        raise exception 'ASSERTION FAILED: removal touched other companies';
    end if;
    if not exists (select 1 from public.profiles where user_id = v_invitee) then
        raise exception 'ASSERTION FAILED: removal deleted the shared profile';
    end if;
    if exists (select 1 from public.invitation_member where tenant_id = v_tenant and email = 'regr-invitee@invite.test') then
        raise exception 'ASSERTION FAILED: removed member''s invitation rows remain';
    end if;
    if not exists (
        select 1 from public.tenant_member_removals
        where tenant_id = v_tenant and removed_user_id = v_invitee and removed_by = v_owner and membership_role = 'employee'
    ) then
        raise exception 'ASSERTION FAILED: removal audit row missing';
    end if;

    -- 19. The removed person can be invited back.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'CREATED' then raise exception 'ASSERTION FAILED: removed member cannot be re-invited (%)', v_row.outcome; end if;

    raise exception 'MEMBER_INVITATION_REGRESSION_PASSED (19 checks; all fixtures rolled back)';
end;
$$;
