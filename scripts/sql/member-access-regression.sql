-- Regression for supabase/migrations/20261001140000_member_block_enable.sql (set_tenant_member_access):
-- the owner blocks and enables employees by changing membership_status only — no row is deleted.
--
-- Runs entirely inside one DO block that ALWAYS ends by raising, so every fixture row is rolled back.
-- A passing run raises 'MEMBER_ACCESS_REGRESSION_PASSED ...'; a failed assertion raises
-- 'ASSERTION FAILED: ...' instead.
do $$
declare
    v_owner uuid := gen_random_uuid();
    v_employee uuid := gen_random_uuid();
    v_other_owner uuid := gen_random_uuid();
    v_tenant uuid;
    v_other_tenant uuid;
    v_plan uuid;
    v_sub uuid;
    v_outcome text;
    v_failed boolean;
    v_rows_before bigint;
    v_usage record;
begin
    insert into auth.users (id, instance_id, aud, role, email)
    values
        (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-access-owner@access.test'),
        (v_employee, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-access-employee@access.test'),
        (v_other_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regr-access-other@access.test');

    insert into public.tenants (tenant_name, timezone) values ('Access Co', 'Asia/Kolkata') returning tenant_id into v_tenant;
    insert into public.tenants (tenant_name, timezone) values ('Access Other Co', 'Asia/Kolkata') returning tenant_id into v_other_tenant;
    insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_tenant, v_owner, 'owner');
    insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_tenant, v_employee, 'employee');
    insert into public.tenant_memberships (tenant_id, user_id, membership_role) values (v_other_tenant, v_other_owner, 'owner');
    insert into public.tenants_subscriptions (tenant_id) values (v_tenant), (v_other_tenant);
    insert into public.profiles (user_id, full_name, phone_number, professional_role)
    values
        (v_owner, 'Owner', '919876543210', 'Director'),
        (v_employee, 'Employee', '919876543210', 'Sales'),
        (v_other_owner, 'Other Owner', '919876543210', 'Director');

    -- Access Co pays for exactly 2 seats: the owner and the employee.
    insert into public.billing_plans (plan_code, plan_name, tier, billing_period, razorpay_plan_id, price_per_seat_paise, total_count)
    values ('regr_access_plan', 'Regression Access Plan', 'pro', 'monthly', 'plan_REGRACCESS', 49900, 12)
    returning billing_plan_id into v_plan;
    insert into public.billing_subscriptions (
        tenant_id, billing_plan_id, razorpay_subscription_id, seat_quantity, razorpay_status,
        current_period_start, current_period_end, created_by_user_id
    ) values (v_tenant, v_plan, 'sub_REGRACCESS1', 2, 'active', now(), now() + interval '30 days', v_owner)
    returning billing_subscription_id into v_sub;
    update public.tenants_subscriptions
    set subscription_status = 'active',
        current_period_started_at = now(),
        current_period_ends_at = now() + interval '30 days',
        active_billing_subscription_id = v_sub
    where tenant_id = v_tenant;

    select count(*) into v_rows_before from public.tenant_memberships where tenant_id = v_tenant;

    -- 1. Only the active owner of THIS company can change access.
    v_failed := false;
    begin
        perform public.set_tenant_member_access(v_tenant, v_other_owner, v_employee, 'blocked');
    exception when sqlstate '42501' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: another company''s owner blocked an employee'; end if;
    v_failed := false;
    begin
        perform public.set_tenant_member_access(v_tenant, v_employee, v_employee, 'active');
    exception when sqlstate '42501' then
        v_failed := true;
    end;
    if not v_failed then raise exception 'ASSERTION FAILED: an employee changed access'; end if;

    -- 2. Only 'active' and 'blocked' are accepted.
    v_outcome := public.set_tenant_member_access(v_tenant, v_owner, v_employee, 'removed');
    if v_outcome <> 'INVALID_STATUS' then raise exception 'ASSERTION FAILED: invalid status accepted (%)', v_outcome; end if;

    -- 3. The owner can never be blocked (only employee rows are touched).
    v_outcome := public.set_tenant_member_access(v_tenant, v_owner, v_owner, 'blocked');
    if v_outcome <> 'NOT_FOUND' then raise exception 'ASSERTION FAILED: owner blockable (%)', v_outcome; end if;
    if (select membership_status from public.tenant_memberships where user_id = v_owner) <> 'active' then
        raise exception 'ASSERTION FAILED: owner status changed';
    end if;

    -- 4. Someone outside the company is not found.
    v_outcome := public.set_tenant_member_access(v_tenant, v_owner, v_other_owner, 'blocked');
    if v_outcome <> 'NOT_FOUND' then raise exception 'ASSERTION FAILED: outsider found (%)', v_outcome; end if;

    -- 5. Block changes the status only: the row, the profile and the row count all stay.
    v_outcome := public.set_tenant_member_access(v_tenant, v_owner, v_employee, 'blocked');
    if v_outcome <> 'UPDATED' then raise exception 'ASSERTION FAILED: block failed (%)', v_outcome; end if;
    if (select membership_status from public.tenant_memberships where user_id = v_employee) <> 'blocked' then
        raise exception 'ASSERTION FAILED: employee not blocked';
    end if;
    if (select count(*) from public.tenant_memberships where tenant_id = v_tenant) <> v_rows_before then
        raise exception 'ASSERTION FAILED: blocking changed the number of membership rows';
    end if;
    if not exists (select 1 from public.profiles where user_id = v_employee) then
        raise exception 'ASSERTION FAILED: blocking deleted the profile';
    end if;

    -- 6. A blocked member frees their seat (seats count active members only).
    select * into v_usage from public.tenant_seat_usage(v_tenant);
    if v_usage.active_members <> 1 then raise exception 'ASSERTION FAILED: blocked member still counted (%)', v_usage.active_members; end if;

    -- 7. Blocking twice is harmless.
    v_outcome := public.set_tenant_member_access(v_tenant, v_owner, v_employee, 'blocked');
    if v_outcome <> 'UPDATED' then raise exception 'ASSERTION FAILED: repeat block failed (%)', v_outcome; end if;

    -- 8. A blocked person still belongs to this company, so no other company can invite them.
    if (select outcome from public.create_member_invitation(v_other_tenant, v_other_owner, 'regr-access-employee@access.test', 'employee')) <> 'HAS_ACCOUNT' then
        raise exception 'ASSERTION FAILED: blocked member invitable by another company';
    end if;

    -- 9. Enable needs a free seat: fill the freed seat with a pending invitation, then enable fails.
    insert into public.invitation_member (tenant_id, email, membership_role, invited_by)
    values (v_tenant, 'seat-taker@access.test', 'employee', v_owner);
    v_outcome := public.set_tenant_member_access(v_tenant, v_owner, v_employee, 'active');
    if v_outcome <> 'NO_SEAT' then raise exception 'ASSERTION FAILED: enabled with no free seat (%)', v_outcome; end if;
    if (select membership_status from public.tenant_memberships where user_id = v_employee) <> 'blocked' then
        raise exception 'ASSERTION FAILED: refused enable still changed the status';
    end if;

    -- 10. With the seat free again, Enable restores access on the same row.
    delete from public.invitation_member where tenant_id = v_tenant and email = 'seat-taker@access.test';
    v_outcome := public.set_tenant_member_access(v_tenant, v_owner, v_employee, 'active');
    if v_outcome <> 'UPDATED' then raise exception 'ASSERTION FAILED: enable failed (%)', v_outcome; end if;
    if (select membership_status from public.tenant_memberships where user_id = v_employee) <> 'active' then
        raise exception 'ASSERTION FAILED: employee not enabled';
    end if;
    if (select count(*) from public.tenant_memberships where tenant_id = v_tenant) <> v_rows_before then
        raise exception 'ASSERTION FAILED: enabling changed the number of membership rows';
    end if;

    -- 11. A company whose paid period has ended cannot enable anyone.
    update public.tenant_memberships set membership_status = 'blocked' where user_id = v_employee;
    update public.tenants_subscriptions
    set current_period_started_at = now() - interval '31 days',
        current_period_ends_at = now() - interval '1 day'
    where tenant_id = v_tenant;
    v_outcome := public.set_tenant_member_access(v_tenant, v_owner, v_employee, 'active');
    if v_outcome <> 'NO_SEAT' then raise exception 'ASSERTION FAILED: enabled without a paid plan (%)', v_outcome; end if;

    -- 12. Signed-in users cannot call the function directly; only the server (service role) can.
    if has_function_privilege('authenticated', 'public.set_tenant_member_access(uuid, uuid, uuid, text)', 'execute')
       or has_function_privilege('anon', 'public.set_tenant_member_access(uuid, uuid, uuid, text)', 'execute') then
        raise exception 'ASSERTION FAILED: set_tenant_member_access callable by anon/authenticated';
    end if;

    raise exception 'MEMBER_ACCESS_REGRESSION_PASSED (12 checks; all fixtures rolled back)';
end;
$$;
