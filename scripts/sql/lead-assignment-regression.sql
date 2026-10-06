-- Regression for supabase/migrations/20261006120000_lead_assignment_by_ad.sql:
-- auto-assign by ad rule (active assignees only, never across tenants), manual assign/unassign, owner-only
-- rules, "apply to unassigned", the lead_assigned timeline row and its actor, member removal clean-up,
-- the tenant-membership FK, the rules overview, and grants.
--
-- Everything runs in one transaction that ends in ROLLBACK, so no fixture survives. A failed assertion
-- raises 'Assertion failed: ...'; a clean run ends with the NOTICE 'LEAD_ASSIGNMENT_REGRESSION_PASSED'.
-- Run it on a dev branch only (or paste the migration body ahead of it to test before applying).
begin;
set local statement_timeout = '60s';

create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %', message; end if; end;
$$;

-- Runs p_sql and requires it to fail with SQLSTATE p_state. Anything else (success or another error) fails.
create function pg_temp.expect_error(p_sql text, p_state text, message text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then return; end if;
    raise exception 'Assertion failed: % (expected SQLSTATE %, got % - %)', message, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'Assertion failed: % (expected SQLSTATE %, statement succeeded)', message, p_state;
end;
$$;

create function pg_temp.assign_count(p_lead uuid) returns bigint language sql as $$
  select count(*) from public.lead_activities where lead_id = p_lead and type = 'lead_assigned';
$$;

-- Fixtures. Tenant A: owner, two active employees, one blocked employee. Tenant B: owner and one employee.
insert into auth.users (id, instance_id, aud, role, email) values
  ('52000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'assign-owner-a@assign.test'),
  ('52000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'assign-emp-a1@assign.test'),
  ('52000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'assign-emp-a2@assign.test'),
  ('52000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'assign-blocked-a@assign.test'),
  ('52000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'assign-owner-b@assign.test'),
  ('52000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'assign-emp-b@assign.test');
insert into public.tenants (tenant_id, tenant_name) values
  ('52000000-0000-0000-0000-000000000001', 'Assignment Regression A'),
  ('52000000-0000-0000-0000-000000000002', 'Assignment Regression B');
insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status) values
  ('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-0000000000a1', 'owner', 'active'),
  ('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-0000000000a2', 'employee', 'active'),
  ('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-0000000000a3', 'employee', 'active'),
  ('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-0000000000a4', 'employee', 'blocked'),
  ('52000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-0000000000b1', 'owner', 'active'),
  ('52000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-0000000000b2', 'employee', 'active');
insert into public.meta_connections (id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted) values
  ('52000000-0000-0000-0000-000000000003', '52000000-0000-0000-0000-000000000001', 'assign-user-a', 'fixture'),
  ('52000000-0000-0000-0000-000000000013', '52000000-0000-0000-0000-000000000002', 'assign-user-b', 'fixture');
insert into public.facebook_pages (id, tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, page_access_token_encrypted, connected_at) values
  ('52000000-0000-0000-0000-000000000004', '52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000003', 'assign-page-a', 'Assign Page A', 'fixture', now() - interval '1 day'),
  ('52000000-0000-0000-0000-000000000014', '52000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000013', 'assign-page-b', 'Assign Page B', 'fixture', now() - interval '1 day');

-- Creates one lead through the real webhook -> claim -> complete RPC chain (not a direct INSERT), so the
-- triggers fire exactly the way they do in production. p_ad_id NULL = an unattributed lead.
create function pg_temp.new_lead(p_tenant uuid, p_page_record uuid, p_page_id text, p_ad_id text) returns uuid language plpgsql as $$
declare v_event uuid; v_claimed public.meta_webhook_notification_events; v_lead uuid;
begin
  insert into public.meta_webhook_notification_events (tenant_id, facebook_page_record_id, facebook_page_id,
    meta_entry_id, meta_entry_time, leadgen_id, form_id, lead_created_time, raw_webhook_change)
  values (p_tenant, p_page_record, p_page_id, 'entry', now(), gen_random_uuid()::text, 'form', now(), '{}')
  returning id into v_event;
  select * into v_claimed from public.claim_meta_webhook_notification_event(v_event);
  perform public.complete_meta_lead_retrieval_event(v_event, v_claimed.claim_token, '[]', null, '{}', now(), p_ad_id);
  select id into v_lead from public.lead_data where webhook_notification_event_id = v_event;
  return v_lead;
end;
$$;
create function pg_temp.lead_a(p_ad text) returns uuid language sql as $$
  select pg_temp.new_lead('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000004', 'assign-page-a', p_ad);
$$;
create function pg_temp.lead_b(p_ad text) returns uuid language sql as $$
  select pg_temp.new_lead('52000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000014', 'assign-page-b', p_ad);
$$;

-- The assignee of one lead. Takes the lead id as an ARGUMENT, so pg_temp.lead_a(...) runs exactly once (a volatile
-- call inside a WHERE clause would run per row), and fails loudly if the lead does not exist, so an
-- "is null" check can never pass because nothing was found.
create function pg_temp.assignee_of(p_lead uuid) returns uuid language plpgsql as $$
declare v_assignee uuid; v_rows integer;
begin
  select assigned_user_id into v_assignee from public.lead_data where id = p_lead;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'Assertion failed: lead % not found', p_lead; end if;
  return v_assignee;
end;
$$;

do $$
declare
  t_a constant uuid := '52000000-0000-0000-0000-000000000001';
  t_b constant uuid := '52000000-0000-0000-0000-000000000002';
  owner_a constant uuid := '52000000-0000-0000-0000-0000000000a1';
  emp_a1 constant uuid := '52000000-0000-0000-0000-0000000000a2';
  emp_a2 constant uuid := '52000000-0000-0000-0000-0000000000a3';
  blocked_a constant uuid := '52000000-0000-0000-0000-0000000000a4';
  owner_b constant uuid := '52000000-0000-0000-0000-0000000000b1';
  emp_b constant uuid := '52000000-0000-0000-0000-0000000000b2';
  v_lead uuid; v_lead2 uuid; v_lead3 uuid; v_lead_b uuid;
  v_act public.lead_activities;
  v_assignee uuid;
  v_count integer;
  v_rows bigint;
begin
  -- TC1: a lead from an ad with no rule is stored Unassigned and logs no assignment.
  v_lead := pg_temp.lead_a('ad-1');
  select assigned_user_id into v_assignee from public.lead_data where id = v_lead;
  perform pg_temp.assert_true(v_assignee is null, 'TC1: no rule -> Unassigned');
  perform pg_temp.assert_true(pg_temp.assign_count(v_lead) = 0, 'TC1: no lead_assigned row');

  -- TC2: only the active OWNER of the tenant can set a rule.
  perform pg_temp.assert_true(public.set_lead_ad_assignment_rule(t_a, owner_a, 'ad-1', emp_a1) = 'UPDATED', 'TC2: owner sets rule');
  perform pg_temp.expect_error(format('select public.set_lead_ad_assignment_rule(%L,%L,%L,%L)', t_a, emp_a1, 'ad-1', emp_a2), '42501', 'TC2: employee cannot set a rule');
  perform pg_temp.expect_error(format('select public.set_lead_ad_assignment_rule(%L,%L,%L,%L)', t_a, owner_b, 'ad-1', emp_a2), '42501', 'TC2: another tenant''s owner cannot set a rule');
  perform pg_temp.assert_true((select assignee_user_id from public.lead_ad_assignment_rules where tenant_id = t_a and ad_id = 'ad-1') = emp_a1, 'TC2: rejected calls changed nothing');

  -- TC3: the assignee must be an ACTIVE member of the same tenant; the ad must be this tenant's.
  perform pg_temp.assert_true(public.set_lead_ad_assignment_rule(t_a, owner_a, 'ad-1', blocked_a) = 'INVALID_ASSIGNEE', 'TC3: blocked assignee rejected');
  perform pg_temp.assert_true(public.set_lead_ad_assignment_rule(t_a, owner_a, 'ad-1', emp_b) = 'INVALID_ASSIGNEE', 'TC3: other tenant''s member rejected');
  perform pg_temp.assert_true(public.set_lead_ad_assignment_rule(t_a, owner_a, 'no-such-ad', emp_a1) = 'AD_NOT_FOUND', 'TC3: unknown ad rejected');
  perform pg_temp.assert_true(public.set_lead_ad_assignment_rule(t_b, owner_b, 'ad-1', emp_b) = 'AD_NOT_FOUND', 'TC3: tenant B cannot use tenant A''s ad');

  -- TC4: a new lead from the ad is stored already assigned, logged once as System, after lead_created.
  v_lead2 := pg_temp.lead_a('ad-1');
  select assigned_user_id into v_assignee from public.lead_data where id = v_lead2;
  perform pg_temp.assert_true(v_assignee = emp_a1, 'TC4: auto-assigned to the rule assignee');
  perform pg_temp.assert_true(pg_temp.assign_count(v_lead2) = 1, 'TC4: exactly one lead_assigned row');
  select * into v_act from public.lead_activities where lead_id = v_lead2 and type = 'lead_assigned';
  perform pg_temp.assert_true(v_act.created_by is null and v_act.tenant_id = t_a and v_act.summary like 'Auto-assigned to %'
    and (v_act.metadata ->> 'auto')::boolean is true and (v_act.metadata ->> 'new')::uuid = emp_a1, 'TC4: System actor and metadata');
  perform pg_temp.assert_true(v_act.created_at >= (select created_at from public.lead_activities where lead_id = v_lead2 and type = 'lead_created'), 'TC4: after lead_created');
  perform pg_temp.assert_true((select assigned_user_id from public.lead_data where id = v_lead) is null, 'TC4: the earlier lead is untouched');

  -- TC5: a lead with no ad, or from another ad, stays Unassigned; another tenant's lead never picks up A's rule.
  perform pg_temp.assert_true(pg_temp.assignee_of(pg_temp.lead_a(null)) is null, 'TC5: unattributed lead Unassigned');
  perform pg_temp.assert_true(pg_temp.assignee_of(pg_temp.lead_a('ad-other')) is null, 'TC5: other ad Unassigned');
  v_lead_b := pg_temp.lead_b('ad-1');
  perform pg_temp.assert_true((select assigned_user_id from public.lead_data where id = v_lead_b) is null, 'TC5: same ad id in tenant B is not affected by tenant A''s rule');

  -- TC6: a blocked assignee is skipped (lead stays Unassigned); enabling them resumes assignment.
  update public.tenant_memberships set membership_status = 'blocked' where tenant_id = t_a and user_id = emp_a1;
  perform pg_temp.assert_true(pg_temp.assignee_of(pg_temp.lead_a('ad-1')) is null, 'TC6: blocked assignee skipped');
  update public.tenant_memberships set membership_status = 'active' where tenant_id = t_a and user_id = emp_a1;
  perform pg_temp.assert_true(pg_temp.assignee_of(pg_temp.lead_a('ad-1')) = emp_a1, 'TC6: re-enabled assignee gets leads again');

  -- TC7: manual assignment by any active member; the actor is recorded; the timeline says what changed.
  v_rows := (select count(*) from public.assign_lead(t_a, v_lead, emp_a2, emp_a1));
  perform pg_temp.assert_true(v_rows = 1 and (select assigned_user_id from public.lead_data where id = v_lead) = emp_a2, 'TC7: employee assigns a lead');
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'lead_assigned';
  perform pg_temp.assert_true(v_act.created_by = emp_a1 and v_act.summary like 'Assigned to %' and (v_act.metadata ->> 'auto')::boolean is false, 'TC7: actor is the person who assigned');
  perform public.assign_lead(t_a, v_lead, owner_a, emp_a1);
  perform pg_temp.assert_true((select count(*) from public.lead_activities where lead_id = v_lead and type = 'lead_assigned' and summary like 'Reassigned: % → %') = 1, 'TC7: reassignment text');
  perform public.assign_lead(t_a, v_lead, owner_a, emp_a1);
  perform pg_temp.assert_true(pg_temp.assign_count(v_lead) = 2, 'TC7: assigning the same person again logs nothing');
  perform public.assign_lead(t_a, v_lead, null, owner_a);
  perform pg_temp.assert_true((select assigned_user_id from public.lead_data where id = v_lead) is null
    and (select count(*) from public.lead_activities where lead_id = v_lead and type = 'lead_assigned' and summary like 'Unassigned (was %') = 1, 'TC7: unassign');
  perform pg_temp.assert_true(current_setting('app.current_user_id', true) in ('', null), 'TC7: actor setting does not leak');

  -- TC8: manual assignment is tenant-safe.
  perform pg_temp.expect_error(format('select public.assign_lead(%L,%L,%L,%L)', t_a, v_lead, blocked_a, emp_a1), '22023', 'TC8: blocked assignee rejected');
  perform pg_temp.expect_error(format('select public.assign_lead(%L,%L,%L,%L)', t_a, v_lead, emp_b, emp_a1), '22023', 'TC8: other tenant''s member rejected as assignee');
  perform pg_temp.expect_error(format('select public.assign_lead(%L,%L,%L,%L)', t_a, v_lead, emp_a1, blocked_a), '42501', 'TC8: blocked actor rejected');
  perform pg_temp.expect_error(format('select public.assign_lead(%L,%L,%L,%L)', t_a, v_lead, emp_a1, emp_b), '42501', 'TC8: another tenant''s member cannot act in tenant A');
  perform pg_temp.assert_true((select count(*) from public.assign_lead(t_b, v_lead, emp_b, owner_b)) = 0, 'TC8: tenant B cannot touch tenant A''s lead');
  perform pg_temp.assert_true((select assigned_user_id from public.lead_data where id = v_lead) is null, 'TC8: nothing changed');

  -- TC9: the composite FK refuses an assignee from another tenant even on a direct write.
  perform pg_temp.expect_error(format('update public.lead_data set assigned_user_id = %L where id = %L', emp_b, v_lead), '23503', 'TC9: FK rejects cross-tenant assignee');

  -- TC10: apply-to-unassigned touches only unassigned leads of that ad, logs the owner, owner only.
  perform pg_temp.assert_true(public.set_lead_ad_assignment_rule(t_a, owner_a, 'ad-other', emp_a2) = 'UPDATED', 'TC10: rule for ad-other');
  v_lead3 := (select id from public.lead_data where tenant_id = t_a and ad_id = 'ad-other' limit 1);
  update public.lead_data set assigned_user_id = emp_a1 where id = v_lead3;
  perform pg_temp.lead_a('ad-other');
  perform pg_temp.lead_a('ad-other');
  perform pg_temp.assert_true((select count(*) from public.lead_data where tenant_id = t_a and ad_id = 'ad-other' and assigned_user_id is not null) = 3, 'TC10: later leads were auto-assigned');
  update public.lead_data set assigned_user_id = null where tenant_id = t_a and ad_id = 'ad-other' and id <> v_lead3;
  v_count := public.apply_lead_ad_assignment_rule(t_a, owner_a, 'ad-other');
  perform pg_temp.assert_true(v_count = 2, 'TC10: applied to the two unassigned leads, got ' || v_count);
  perform pg_temp.assert_true((select assigned_user_id from public.lead_data where id = v_lead3) = emp_a1, 'TC10: an assigned lead is never overwritten');
  perform pg_temp.assert_true((select count(*) from public.lead_activities where tenant_id = t_a and type = 'lead_assigned' and created_by = owner_a
    and metadata ->> 'new' = emp_a2::text) = 2, 'TC10: applied rows are attributed to the owner');
  perform pg_temp.assert_true(public.apply_lead_ad_assignment_rule(t_a, owner_a, 'ad-other') = 0, 'TC10: applying again changes nothing');
  perform pg_temp.expect_error(format('select public.apply_lead_ad_assignment_rule(%L,%L,%L)', t_a, emp_a1, 'ad-other'), '42501', 'TC10: employee cannot apply');
  perform pg_temp.expect_error(format('select public.apply_lead_ad_assignment_rule(%L,%L,%L)', t_a, owner_b, 'ad-other'), '42501', 'TC10: another tenant''s owner cannot apply');
  perform pg_temp.expect_error(format('select public.apply_lead_ad_assignment_rule(%L,%L,%L)', t_a, owner_a, 'no-rule-ad'), 'P0002', 'TC10: no rule');

  -- TC11: the overview is tenant-scoped and counts unassigned leads.
  perform pg_temp.assert_true((select count(*) from public.list_lead_ad_assignments(t_a)) = 2, 'TC11: tenant A sees its two ads');
  perform pg_temp.assert_true((select count(*) from public.list_lead_ad_assignments(t_b)) = 1, 'TC11: tenant B sees only its own ad');
  perform pg_temp.assert_true((select unassigned_leads from public.list_lead_ad_assignments(t_a) where ad_id = 'ad-other') = 0, 'TC11: unassigned count after apply');
  perform pg_temp.assert_true((select assignee_user_id from public.list_lead_ad_assignments(t_b)) is null, 'TC11: tenant B has no rule');

  -- TC12: clearing a rule stops auto-assignment but keeps existing assignments.
  perform pg_temp.assert_true(public.set_lead_ad_assignment_rule(t_a, owner_a, 'ad-other', null) = 'CLEARED', 'TC12: rule cleared');
  perform pg_temp.assert_true(pg_temp.assignee_of(pg_temp.lead_a('ad-other')) is null, 'TC12: no rule -> Unassigned');
  perform pg_temp.assert_true((select count(*) from public.lead_data where tenant_id = t_a and ad_id = 'ad-other' and assigned_user_id = emp_a2) = 2, 'TC12: existing assignments kept');

  -- TC13: removing a member unassigns their leads (System) and drops their rules; other columns survive.
  v_lead := (select id from public.lead_data where tenant_id = t_a and assigned_user_id = emp_a1 limit 1);
  delete from public.tenant_memberships where tenant_id = t_a and user_id = emp_a1;
  perform pg_temp.assert_true(not exists (select 1 from public.lead_data where tenant_id = t_a and assigned_user_id = emp_a1), 'TC13: leads unassigned');
  perform pg_temp.assert_true(exists (select 1 from public.lead_data where id = v_lead and tenant_id = t_a), 'TC13: the lead itself survives');
  perform pg_temp.assert_true(not exists (select 1 from public.lead_ad_assignment_rules where tenant_id = t_a and assignee_user_id = emp_a1), 'TC13: rule dropped');
  perform pg_temp.assert_true(exists (select 1 from public.lead_activities where lead_id = v_lead and type = 'lead_assigned' and created_by is null and summary like 'Unassigned (was %'), 'TC13: logged as System');

  -- TC14: deleting a lead takes its assignment history with it (FK cascade still allowed).
  delete from public.lead_data where id = v_lead_b;
  perform pg_temp.assert_true(not exists (select 1 from public.lead_activities where lead_id = v_lead_b), 'TC14: history removed with the lead');

  -- TC15: grants. The browser roles can read and run nothing; the service role can.
  perform pg_temp.assert_true(not has_table_privilege('authenticated', 'public.lead_ad_assignment_rules', 'select')
    and not has_table_privilege('anon', 'public.lead_ad_assignment_rules', 'select'), 'TC15: rules table closed to browser roles');
  perform pg_temp.assert_true(has_table_privilege('service_role', 'public.lead_ad_assignment_rules', 'select'), 'TC15: service_role can read rules');
  perform pg_temp.assert_true(not has_table_privilege('service_role', 'public.lead_ad_assignment_rules', 'insert'), 'TC15: rules are written only through the RPC');
  perform pg_temp.assert_true(
    not has_function_privilege('authenticated', 'public.assign_lead(uuid,uuid,uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.set_lead_ad_assignment_rule(uuid,uuid,text,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.apply_lead_ad_assignment_rule(uuid,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_lead_ad_assignments(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.assert_active_tenant_owner(uuid,uuid)', 'execute'), 'TC15: RPCs closed to browser roles');
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.assign_lead(uuid,uuid,uuid,uuid)', 'execute')
    and has_function_privilege('service_role', 'public.set_lead_ad_assignment_rule(uuid,uuid,text,uuid)', 'execute')
    and has_function_privilege('service_role', 'public.apply_lead_ad_assignment_rule(uuid,uuid,text)', 'execute')
    and has_function_privilege('service_role', 'public.list_lead_ad_assignments(uuid)', 'execute'), 'TC15: service_role can run the RPCs');
  perform pg_temp.assert_true((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.lead_ad_assignment_rules'::regclass), 'TC15: RLS enabled and forced');

  raise notice 'LEAD_ASSIGNMENT_REGRESSION_PASSED';
end;
$$;

rollback;
