-- Regression for supabase/migrations/20260922120000_invitation_member.sql as changed by
-- 20260926120000_billing_razorpay.sql (invitations need a paid plan and a free seat),
-- 20260929130000_invitations_employee_only.sql (invitations grant 'employee' only) and
-- 20261001100000_one_to_one_membership.sql (one login belongs to exactly one company; an email that
-- already has an account cannot be invited).
--
-- The two main fixture companies are on an ACTIVE paid plan with plenty of seats, so the membership
-- steps reach the code they test; steps 17-20 cover the role and billing gates explicitly.
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
    v_trial_owner uuid := gen_random_uuid();
    v_tenant uuid;
    v_other_tenant uuid;
    v_trial_tenant uuid;
    v_row record;
    v_tenants_before bigint;
    v_subscriptions_before bigint;
    v_invitation_id uuid;
    v_failed boolean;
    v_plan uuid;
    v_sub uuid;
    v_other_sub uuid;

begin
    insert into auth.users (id, instance_id, aud, role, email)
    values
        (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-owner@invite.test'),
        (v_invitee, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-invitee@invite.test'),
        (v_outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-outsider@invite.test'),
        (v_other_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-other-owner@invite.test'),
        (v_trial_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-trial-owner@invite.test');

    insert into public.tenants (tenant_name, timezone) values ('Regression Co', 'Asia/Kolkata') returning tenant_id into v_tenant;
    insert into public.tenants (tenant_name, timezone) values ('Other Co', 'Asia/Kolkata') returning tenant_id into v_other_tenant;
    insert into public.tenants (tenant_name, timezone) values ('Trial Co', 'Asia/Kolkata') returning tenant_id into v_trial_tenant;
    insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_tenant, v_owner, 'owner');
    insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_other_tenant, v_other_owner, 'owner');
    insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_trial_tenant, v_trial_owner, 'owner');
    insert into public.tenants_subscriptions (tenant_id) values (v_tenant), (v_other_tenant), (v_trial_tenant);

    -- Regression Co and Other Co pay for 50 seats (the owner, the invitees and pending invitations all
    -- count). Trial Co stays on its free trial.
    insert into public.billing_plans (plan_code, plan_name, tier, billing_period, razorpay_plan_id, price_per_seat_paise, total_count)
    values ('regr_plan', 'Regression Plan', 'pro', 'monthly', 'plan_REGRPLAN', 49900, 12)
    returning billing_plan_id into v_plan;
    insert into public.billing_subscriptions (
        tenant_id, billing_plan_id, razorpay_subscription_id, seat_quantity, razorpay_status,
        current_period_start, current_period_end, created_by_user_id
    ) values (v_tenant, v_plan, 'sub_REGRSUB1', 50, 'active', now(), now() + interval '30 days', v_owner)
    returning billing_subscription_id into v_sub;
    insert into public.billing_subscriptions (
        tenant_id, billing_plan_id, razorpay_subscription_id, seat_quantity, razorpay_status,
        current_period_start, current_period_end, created_by_user_id
    ) values (v_other_tenant, v_plan, 'sub_REGRSUB2', 50, 'active', now(), now() + interval '30 days', v_other_owner)
    returning billing_subscription_id into v_other_sub;
    update public.tenants_subscriptions
    set subscription_status = 'active',
        current_period_started_at = now(),
        current_period_ends_at = now() + interval '30 days',
        active_billing_subscription_id = v_sub
    where tenant_id = v_tenant;
    update public.tenants_subscriptions
    set subscription_status = 'active',
        current_period_started_at = now(),
        current_period_ends_at = now() + interval '30 days',
        active_billing_subscription_id = v_other_sub
    where tenant_id = v_other_tenant;
    insert into public.profiles (user_id, full_name, phone_number, professional_role)
    values
        (v_owner, 'Owner', '919876543210', 'Director'),
        (v_other_owner, 'Other Owner', '919876543210', 'Director'),
        (v_trial_owner, 'Trial Owner', '919876543210', 'Director');

    -- 1. The owner role can never be granted by invitation.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'x@invite.test', 'owner');
    if v_row.outcome <> 'INVALID_ROLE' then raise exception 'ASSERTION FAILED: owner role accepted (%)', v_row.outcome; end if;

    -- 2. Only the tenant's owner can invite.
    select * into v_row from public.create_member_invitation(v_tenant, v_other_owner, 'x@invite.test', 'employee');
    if v_row.outcome <> 'NOT_OWNER' then raise exception 'ASSERTION FAILED: non-owner could invite (%)', v_row.outcome; end if;

    -- 3. One login, one company: the owner of ANOTHER company cannot be invited (any letter case).
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'REGR-other-owner@invite.test', 'employee');
    if v_row.outcome <> 'HAS_ACCOUNT' then
        raise exception 'ASSERTION FAILED: member of another company was invitable (%)', v_row.outcome;
    end if;
    if exists (select 1 from public.invitation_member where email = 'regr-other-owner@invite.test') then
        raise exception 'ASSERTION FAILED: a refused HAS_ACCOUNT invitation left a row behind';
    end if;

    -- 4. A member of THIS company cannot be invited again.
    select * into v_row from public.create_member_invitation(v_other_tenant, v_other_owner, 'regr-other-owner@invite.test', 'employee');
    if v_row.outcome <> 'ALREADY_MEMBER' then raise exception 'ASSERTION FAILED: same-tenant member invited (%)', v_row.outcome; end if;

    -- 5. A login that never finished setup (no profile) can be invited, carrying its auth user id.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, '  Regr-Invitee@Invite.test ', 'employee');
    if v_row.outcome <> 'CREATED' or v_row.user_id is distinct from v_invitee then
        raise exception 'ASSERTION FAILED: invitation not created correctly (%, %)', v_row.outcome, v_row.user_id;
    end if;
    v_invitation_id := v_row.invitation_id;

    -- 6. One open invitation per email across ALL companies.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'ALREADY_INVITED' then raise exception 'ASSERTION FAILED: duplicate invite (%)', v_row.outcome; end if;
    select * into v_row from public.create_member_invitation(v_other_tenant, v_other_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'ALREADY_INVITED' then raise exception 'ASSERTION FAILED: second company invited the same email (%)', v_row.outcome; end if;

    -- 7. A user cannot accept an invitation addressed to someone else.
    perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'email', 'regr-outsider@invite.test', 'role', 'authenticated')::text, true);
    v_failed := false;
    begin
        perform public.accept_member_invitation(v_invitation_id, 'Outsider', '919876543210', 'Sales');
    exception when sqlstate 'P0002' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: outsider accepted someone else''s invitation'; end if;

    -- 8. The invitee joins the OWNER'S tenant as employee; no tenant or subscription is created.
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

    -- 9. Accepting twice is idempotent: same tenant, still exactly one membership.
    select * into v_row from public.accept_member_invitation(v_invitation_id, 'Ravi Invitee', '919876543210', 'Sales Executive');
    if v_row.tenant_id <> v_tenant or (select count(*) from public.tenant_memberships where user_id = v_invitee) <> 1 then
        raise exception 'ASSERTION FAILED: second accept was not idempotent';
    end if;

    -- 10. Now that the invitee has an account, another company cannot invite them.
    select * into v_row from public.create_member_invitation(v_other_tenant, v_other_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'HAS_ACCOUNT' then raise exception 'ASSERTION FAILED: employee of another company invitable (%)', v_row.outcome; end if;

    -- 11. The DB itself refuses a second membership for one person, whatever the role.
    v_failed := false;
    begin
        insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_other_tenant, v_invitee, 'employee');
    exception when unique_violation then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: person joined a second company'; end if;

    -- 12. Owner onboarding by an employee cannot create a second company for them.
    select count(*) into v_tenants_before from public.tenants;
    v_failed := false;
    begin
        perform public.complete_owner_onboarding('Ravi Invitee', '919876543210', 'Ravi Realty', 'Sales Executive', 'Asia/Kolkata');
    exception when unique_violation then
        v_failed := true;
    end;
    if not v_failed or (select count(*) from public.tenants) <> v_tenants_before then
        raise exception 'ASSERTION FAILED: an employee created their own company';
    end if;

    -- 13. An expired invitation cannot be accepted, and does not block a fresh one.
    perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'email', 'regr-outsider@invite.test', 'role', 'authenticated')::text, true);
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-outsider@invite.test', 'employee');
    update public.invitation_member set expires_at = now() - interval '1 minute' where invitation_id = v_row.invitation_id;
    v_failed := false;
    begin
        perform public.accept_member_invitation(v_row.invitation_id, 'Outsider', '919876543210', 'Sales');
    exception when sqlstate 'P0002' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: expired invitation accepted'; end if;
    select * into v_row from public.create_member_invitation(v_other_tenant, v_other_owner, 'regr-outsider@invite.test', 'employee');
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

    -- 15. Removal deletes only that membership and that company's invitation rows, keeps the
    --     profile, and writes an audit row. The owner can never be removed.
    if public.remove_tenant_member(v_tenant, v_owner, v_owner) then
        raise exception 'ASSERTION FAILED: the owner removed themselves';
    end if;
    if not public.remove_tenant_member(v_tenant, v_owner, v_invitee) then
        raise exception 'ASSERTION FAILED: removal did not apply';
    end if;
    if exists (select 1 from public.tenant_memberships where user_id = v_invitee) then
        raise exception 'ASSERTION FAILED: membership still present after removal';
    end if;
    if not exists (select 1 from public.profiles where user_id = v_invitee) then
        raise exception 'ASSERTION FAILED: removal deleted the profile';
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

    -- 16. A removed person still has an account, so no company can invite them again.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'regr-invitee@invite.test', 'employee');
    if v_row.outcome <> 'HAS_ACCOUNT' then raise exception 'ASSERTION FAILED: removed member re-invitable (%)', v_row.outcome; end if;

    -- 17. Invitations grant 'employee' only: 'admin' is refused by the RPC itself.
    select * into v_row from public.create_member_invitation(v_tenant, v_owner, 'admin-target@invite.test', 'admin');
    if v_row.outcome <> 'INVALID_ROLE' then raise exception 'ASSERTION FAILED: admin invitation not refused (%)', v_row.outcome; end if;
    if exists (select 1 from public.invitation_member where email = 'admin-target@invite.test') then
        raise exception 'ASSERTION FAILED: a refused admin invitation left a row behind';
    end if;

    -- 18. ...and the table cannot hold one even when written directly.
    v_failed := false;
    begin
        insert into public.invitation_member (tenant_id, email, membership_role, invited_by)
        values (v_tenant, 'direct-admin@invite.test', 'admin', v_owner);
    exception when check_violation then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: admin-role row inserted directly'; end if;

    -- 19. A company still on its free trial cannot invite.
    select * into v_row from public.create_member_invitation(v_trial_tenant, v_trial_owner, 'trial-target@invite.test', 'employee');
    if v_row.outcome <> 'PLAN_REQUIRED' then raise exception 'ASSERTION FAILED: trial company could invite (%)', v_row.outcome; end if;

    -- 20. A paid company with no free seat cannot invite: shrink 'Other Co' to exactly its seats in use
    --     (active members plus the pending invitation from step 13).
    update public.billing_subscriptions
    set seat_quantity = (select count(*) from public.tenant_memberships where tenant_id = v_other_tenant and membership_status = 'active')
        + (select count(*) from public.invitation_member where tenant_id = v_other_tenant and status = 'pending' and expires_at > now())
    where billing_subscription_id = v_other_sub;
    select * into v_row from public.create_member_invitation(v_other_tenant, v_other_owner, 'full-target@invite.test', 'employee');
    if v_row.outcome <> 'SEAT_LIMIT_REACHED' then raise exception 'ASSERTION FAILED: invited with no free seat (%)', v_row.outcome; end if;

    raise exception 'MEMBER_INVITATION_REGRESSION_PASSED (20 checks; all fixtures rolled back)';
end;
$$;
