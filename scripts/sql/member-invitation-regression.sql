-- Regression for supabase/migrations/20260922120000_invitation_member.sql.
--
-- Runs entirely inside one DO block that ALWAYS ends by raising, so every fixture row (auth users,
-- tenant, memberships, invitations) is rolled back. A passing run raises
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

    -- 1. The owner role can never be granted by invitation.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'x@invite.test', 'owner');
    if v_row.outcome <> 'INVALID_ROLE' then raise exception 'ASSERTION FAILED: owner role accepted (%)', v_row.outcome; end if;

    -- 2. Only the tenant's owner can invite.
    select * into v_row from public.create_member_invitation(v_tenant, v_other_owner, 'x@invite.test', 'employee');
    if v_row.outcome <> 'NOT_OWNER' then raise exception 'ASSERTION FAILED: non-owner could invite (%)', v_row.outcome; end if;

    -- 3. Someone already in a company (any company) cannot be invited.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'REGR-other-owner@invite.test', 'employee');
    if v_row.outcome <> 'ALREADY_MEMBER' then raise exception 'ASSERTION FAILED: existing member invited (%)', v_row.outcome; end if;

    -- 4. A valid invitation is recorded with the existing auth user id and the chosen role.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, '  Regr-Invitee@Invite.test ', 'admin');
    if v_row.outcome <> 'CREATED' or v_row.user_id is distinct from v_invitee then
        raise exception 'ASSERTION FAILED: invitation not created correctly (%, %)', v_row.outcome, v_row.user_id;
    end if;
    v_invitation_id := v_row.invitation_id;

    -- 5. One open invitation per email, across tenants.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'ALREADY_INVITED' then raise exception 'ASSERTION FAILED: duplicate invite (%)', v_row.outcome; end if;
    select * into v_row from public.create_member_invitation(v_other_tenant, v_other_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'ALREADY_INVITED' then raise exception 'ASSERTION FAILED: cross-tenant duplicate invite (%)', v_row.outcome; end if;

    -- 6. A user with no invitation cannot accept anything.
    perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'email', 'regr-outsider@invite.test', 'role', 'authenticated')::text, true);
    v_failed := false;
    begin
        perform public.accept_member_invitation('Outsider', '919876543210', 'Sales');
    exception when sqlstate 'P0002' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: outsider accepted an invitation'; end if;

    -- 7. The invitee joins the OWNER'S tenant with the OWNER'S role; no tenant or subscription is created.
    select count(*) into v_tenants_before from public.tenants;
    select count(*) into v_subscriptions_before from public.tenants_subscriptions;

    perform set_config('request.jwt.claims', json_build_object('sub', v_invitee, 'email', 'regr-invitee@invite.test', 'role', 'authenticated')::text, true);
    select * into v_row from public.accept_member_invitation('Ravi Invitee', '919876543210', 'Sales Executive');

    if v_row.tenant_id <> v_tenant or v_row.membership_role <> 'admin' then
        raise exception 'ASSERTION FAILED: accepted into wrong tenant/role (%, %)', v_row.tenant_id, v_row.membership_role;
    end if;
    if (select count(*) from public.tenants) <> v_tenants_before then
        raise exception 'ASSERTION FAILED: accepting an invitation created a tenant';
    end if;
    if (select count(*) from public.tenants_subscriptions) <> v_subscriptions_before then
        raise exception 'ASSERTION FAILED: accepting an invitation created a subscription';
    end if;
    if not exists (
        select 1 from public.tenant_memberships
        where user_id = v_invitee and tenant_id = v_tenant and membership_role = 'admin' and membership_status = 'active'
    ) then
        raise exception 'ASSERTION FAILED: membership row missing or wrong';
    end if;
    if not exists (select 1 from public.profiles where user_id = v_invitee and full_name = 'Ravi Invitee') then
        raise exception 'ASSERTION FAILED: profile row missing';
    end if;
    if (select status from public.invitation_member where invitation_id = v_invitation_id) <> 'accepted' then
        raise exception 'ASSERTION FAILED: invitation not marked accepted';
    end if;

    -- 8. Accepting twice is idempotent: same tenant, still exactly one membership.
    select * into v_row from public.accept_member_invitation('Ravi Invitee', '919876543210', 'Sales Executive');
    if v_row.tenant_id <> v_tenant or (select count(*) from public.tenant_memberships where user_id = v_invitee) <> 1 then
        raise exception 'ASSERTION FAILED: second accept was not idempotent';
    end if;

    -- 9. The members list shows both people with their roles and emails.
    if (select count(*) from public.list_tenant_members(v_tenant)) <> 2
        or not exists (select 1 from public.list_tenant_members(v_tenant) where email = 'regr-invitee@invite.test' and membership_role = 'admin')
    then
        raise exception 'ASSERTION FAILED: list_tenant_members is wrong';
    end if;

    -- 10. An expired invitation cannot be accepted, and does not block a fresh one.
    perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'email', 'regr-outsider@invite.test', 'role', 'authenticated')::text, true);
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-outsider@invite.test', 'employee');
    update public.invitation_member set expires_at = now() - interval '1 minute' where invitation_id = v_row.invitation_id;
    v_failed := false;
    begin
        perform public.accept_member_invitation('Outsider', '919876543210', 'Sales');
    exception when sqlstate 'P0002' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: expired invitation accepted'; end if;
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-outsider@invite.test', 'employee');
    if v_row.outcome <> 'CREATED' then raise exception 'ASSERTION FAILED: expired invite blocked a new one (%)', v_row.outcome; end if;

    -- 11. The table can't hold an owner-role invitation even when written directly.
    v_failed := false;
    begin
        insert into public.invitation_member (tenant_id, email, membership_role, invited_by)
        values (v_tenant, 'direct@invite.test', 'owner', v_owner);
    exception when check_violation then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: owner-role row inserted directly'; end if;

    raise exception 'MEMBER_INVITATION_REGRESSION_PASSED (11 checks; all fixtures rolled back)';
end;
$$;
