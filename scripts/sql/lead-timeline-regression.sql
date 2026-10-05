-- Regression for supabase/migrations/20261005120000_lead_notes_tasks_timeline.sql:
-- lead_created / status_change / note / task timeline triggers, the one-open-task rule, the task guard
-- (reschedule while open, final close), append-only guards, tenant isolation and grants, and the backfill.
--
-- Everything runs in one transaction that ends in ROLLBACK, so no fixture survives. A failed assertion
-- raises 'Assertion failed: ...'; a clean run ends with the NOTICE 'LEAD_TIMELINE_REGRESSION_PASSED'.
-- Run it on a dev branch only.
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

create function pg_temp.activity_count(p_lead uuid, p_type text) returns bigint language sql as $$
  select count(*) from public.lead_activities where lead_id = p_lead and type = p_type;
$$;

-- Fixtures: tenant A (with a connected Page, so leads can be created through the real pipeline) and
-- tenant B, each with one active owner. Tenant A also has a blocked employee.
insert into auth.users (id, instance_id, aud, role, email) values
  ('51000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'timeline-owner-a@timeline.test'),
  ('51000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'timeline-blocked-a@timeline.test'),
  ('51000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'timeline-owner-b@timeline.test');
insert into public.tenants (tenant_id, tenant_name) values
  ('51000000-0000-0000-0000-000000000001', 'Timeline Regression A'),
  ('51000000-0000-0000-0000-000000000002', 'Timeline Regression B');
insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status) values
  ('51000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-0000000000a1', 'owner', 'active'),
  ('51000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-0000000000a2', 'employee', 'blocked'),
  ('51000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-0000000000b1', 'owner', 'active');
insert into public.meta_connections (id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted)
values ('51000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000001', 'timeline-user', 'fixture');
insert into public.facebook_pages (id, tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, page_access_token_encrypted, connected_at)
values ('51000000-0000-0000-0000-000000000004', '51000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000003', 'timeline-page', 'Timeline Page', 'fixture', now() - interval '1 day');

-- Creates one lead through the real webhook -> claim -> complete RPC chain (not a direct INSERT), so the
-- lead_created trigger fires exactly the way it does in production.
create function pg_temp.new_lead() returns uuid language plpgsql as $$
declare v_event uuid; v_claimed public.meta_webhook_notification_events; v_lead uuid;
begin
  insert into public.meta_webhook_notification_events (tenant_id, facebook_page_record_id, facebook_page_id,
    meta_entry_id, meta_entry_time, leadgen_id, form_id, lead_created_time, raw_webhook_change)
  values ('51000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000004', 'timeline-page', 'entry', now(),
    gen_random_uuid()::text, 'form', now(), '{}')
  returning id into v_event;
  select * into v_claimed from public.claim_meta_webhook_notification_event(v_event);
  perform public.complete_meta_lead_retrieval_event(v_event, v_claimed.claim_token, '[]', null, '{}', now(), null);
  select id into v_lead from public.lead_data where webhook_notification_event_id = v_event;
  return v_lead;
end;
$$;

do $$
declare
  t_a constant uuid := '51000000-0000-0000-0000-000000000001';
  t_b constant uuid := '51000000-0000-0000-0000-000000000002';
  owner_a constant uuid := '51000000-0000-0000-0000-0000000000a1';
  blocked_a constant uuid := '51000000-0000-0000-0000-0000000000a2';
  owner_b constant uuid := '51000000-0000-0000-0000-0000000000b1';
  v_lead uuid;
  v_task public.lead_tasks;
  v_task2 public.lead_tasks;
  v_act public.lead_activities;
  v_count bigint;
  v_note_id uuid;
  v_long text := repeat('Customer asked for the brochure and a callback after the weekend. ', 4);
begin
  -- TC1: a new lead gets exactly one lead_created row, actor System (NULL).
  v_lead := pg_temp.new_lead();
  perform pg_temp.assert_true(v_lead is not null, 'TC1: fixture lead created');
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'lead_created') = 1, 'TC1: exactly one lead_created');
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'lead_created';
  perform pg_temp.assert_true(v_act.created_by is null and v_act.tenant_id = t_a
    and v_act.summary = 'Lead created · Status: New Lead' and v_act.metadata = '{"status": "New Lead"}'::jsonb,
    'TC1: lead_created content and System actor');
  perform pg_temp.assert_true((select count(*) from public.lead_activities where lead_id = v_lead) = 1, 'TC1: nothing else logged on insert');

  -- TC2: two status changes through the RPC -> exactly two status_change rows with summary, metadata, actor.
  perform public.update_lead_status(t_a, v_lead, 'Working', owner_a);
  perform public.update_lead_status(t_a, v_lead, 'Site visit pending', owner_a);
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'status_change') = 2, 'TC2: exactly two status_change rows');
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'status_change' order by created_at desc, id desc limit 1;
  perform pg_temp.assert_true(v_act.summary = 'Status: Working → Site visit pending'
    and v_act.metadata = '{"old": "Working", "new": "Site visit pending"}'::jsonb and v_act.created_by = owner_a,
    'TC2: latest status_change content and telecaller actor');
  perform pg_temp.assert_true(coalesce(current_setting('app.current_user_id', true), '') = '', 'TC2: RPC clears the actor setting');

  -- TC3: same status again, and a label-only change -> no new rows.
  perform public.update_lead_status(t_a, v_lead, 'Site visit pending', owner_a);
  update public.lead_data set label = 'Hot' where id = v_lead;
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'status_change') = 2, 'TC3: unchanged status logs nothing');
  perform pg_temp.assert_true((select count(*) from public.lead_activities where lead_id = v_lead) = 3, 'TC3: label change logs nothing');

  -- TC4: actor from another tenant, or a blocked member -> 42501; status untouched, nothing logged.
  perform pg_temp.expect_error(format('select public.update_lead_status(%L, %L, %L, %L)', t_a, v_lead, 'Sale', owner_b), '42501', 'TC4: foreign actor rejected');
  perform pg_temp.expect_error(format('select public.update_lead_status(%L, %L, %L, %L)', t_a, v_lead, 'Sale', blocked_a), '42501', 'TC4: blocked actor rejected');
  perform pg_temp.assert_true((select status from public.lead_data where id = v_lead) = 'Site visit pending', 'TC4: status unchanged');
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'status_change') = 2, 'TC4: nothing logged');
  -- The RPC for tenant B cannot reach tenant A's lead even with a valid tenant-B actor.
  perform pg_temp.assert_true((select count(*) from public.update_lead_status(t_b, v_lead, 'Sale', owner_b)) = 0, 'TC4: cross-tenant lead not matched');
  perform pg_temp.assert_true((select status from public.lead_data where id = v_lead) = 'Site visit pending', 'TC4: cross-tenant status unchanged');

  -- TC5: a direct UPDATE (outside the RPC, e.g. SQL editor) is still logged, actor System.
  update public.lead_data set status = 'Final call' where id = v_lead;
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'status_change' order by created_at desc, id desc limit 1;
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'status_change') = 3 and v_act.created_by is null
    and v_act.summary = 'Status: Site visit pending → Final call', 'TC5: direct update logged as System');

  -- TC6: a long note -> one note_added, summary = first 120 chars (whitespace collapsed) + ellipsis.
  insert into public.lead_notes (tenant_id, lead_id, body, created_by) values (t_a, v_lead, v_long, owner_a) returning id into v_note_id;
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'note_added') = 1, 'TC6: exactly one note_added');
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'note_added';
  perform pg_temp.assert_true(v_act.summary = left(regexp_replace(btrim(v_long), '\s+', ' ', 'g'), 120) || '…'
    and v_act.created_by = owner_a and v_act.metadata = jsonb_build_object('note_id', v_note_id), 'TC6: note summary truncated, actor, note_id');
  perform pg_temp.expect_error(format('insert into public.lead_notes (tenant_id, lead_id, body, created_by) values (%L, %L, %L, %L)', t_a, v_lead, '   ', owner_a), '23514', 'TC6: blank note rejected');

  -- TC7: create a task -> task_created; a second open task -> 23505.
  insert into public.lead_tasks (tenant_id, lead_id, title, description, start_date, due_date, created_by)
  values (t_a, v_lead, 'Call back', 'Confirm site visit slot', date '2026-10-05', date '2026-10-08', owner_a) returning * into v_task;
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'task_created') = 1, 'TC7: exactly one task_created');
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'task_created';
  perform pg_temp.assert_true(v_act.summary = 'Task: Call back · due 08 Oct 2026' and v_act.created_by = owner_a
    and v_act.metadata ->> 'task_id' = v_task.id::text, 'TC7: task_created content');
  perform pg_temp.expect_error(format('insert into public.lead_tasks (tenant_id, lead_id, title, start_date, due_date, created_by) values (%L, %L, %L, %L, %L, %L)',
    t_a, v_lead, 'Second', '2026-10-05', '2026-10-06', owner_a), '23505', 'TC7: second open task rejected');
  perform pg_temp.expect_error(format('insert into public.lead_tasks (tenant_id, lead_id, title, start_date, due_date, created_by) values (%L, %L, %L, %L, %L, %L)',
    t_a, v_lead, 'Backwards', '2026-10-05', '2026-10-01', owner_a), '23514', 'TC7: due before start rejected');

  -- TC8: reschedule -> task_rescheduled {old,new} with the actor; before start_date -> 23514; editing title -> 55000.
  select * into v_task from public.reschedule_lead_task(t_a, v_lead, v_task.id, date '2026-10-10', owner_a);
  perform pg_temp.assert_true(v_task.due_date = date '2026-10-10', 'TC8: due date moved');
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'task_rescheduled') = 1, 'TC8: exactly one task_rescheduled');
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'task_rescheduled';
  perform pg_temp.assert_true(v_act.created_by = owner_a and v_act.metadata ->> 'old' = '2026-10-08' and v_act.metadata ->> 'new' = '2026-10-10'
    and v_act.summary = 'Task rescheduled: Call back · 08 Oct 2026 → 10 Oct 2026', 'TC8: reschedule content and actor');
  perform pg_temp.expect_error(format('select public.reschedule_lead_task(%L, %L, %L, %L, %L)', t_a, v_lead, v_task.id, '2026-10-01', owner_a), '23514', 'TC8: reschedule before start rejected');
  perform pg_temp.expect_error(format('update public.lead_tasks set title = %L where id = %L', 'Renamed', v_task.id), '55000', 'TC8: title immutable');
  perform pg_temp.expect_error(format('update public.lead_tasks set start_date = %L where id = %L', '2026-10-01', v_task.id), '55000', 'TC8: start date immutable');
  perform pg_temp.expect_error(format('select public.reschedule_lead_task(%L, %L, %L, %L, %L)', t_a, v_lead, v_task.id, '2026-10-11', owner_b), '42501', 'TC8: foreign actor cannot reschedule');

  -- TC9: complete -> task_completed with actor = closed_by; then every further change -> 55000, nothing logged.
  select * into v_task from public.close_lead_task(t_a, v_lead, v_task.id, 'completed', owner_a);
  perform pg_temp.assert_true(v_task.status = 'completed' and v_task.closed_at is not null and v_task.closed_by = owner_a, 'TC9: task closed with closed_at/closed_by');
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'task_completed';
  perform pg_temp.assert_true(pg_temp.activity_count(v_lead, 'task_completed') = 1 and v_act.created_by = owner_a
    and v_act.summary = 'Task completed: Call back', 'TC9: task_completed content and actor');
  select count(*) into v_count from public.lead_activities where lead_id = v_lead;
  perform pg_temp.expect_error(format('select public.close_lead_task(%L, %L, %L, %L, %L)', t_a, v_lead, v_task.id, 'completed', owner_a), '55000', 'TC9: complete again rejected');
  perform pg_temp.expect_error(format('select public.close_lead_task(%L, %L, %L, %L, %L)', t_a, v_lead, v_task.id, 'cancelled', owner_a), '55000', 'TC9: cancel after complete rejected');
  -- reschedule_lead_task has no status filter: a closed task must reach the guard, not silently match nothing.
  perform pg_temp.expect_error(format('select public.reschedule_lead_task(%L, %L, %L, %L, %L)', t_a, v_lead, v_task.id, '2026-10-12', owner_a), '55000', 'TC9: reschedule of closed task rejected');
  perform pg_temp.assert_true((select count(*) from public.lead_activities where lead_id = v_lead) = v_count, 'TC9: nothing logged by rejected changes');
  perform pg_temp.assert_true((select count(*) from public.reschedule_lead_task(t_a, v_lead, gen_random_uuid(), date '2026-10-12', owner_a)) = 0, 'TC9: unknown task id matches nothing');
  perform pg_temp.expect_error(format('select public.close_lead_task(%L, %L, %L, %L, %L)', t_a, v_lead, v_task.id, 'open', owner_a), '22023', 'TC9: invalid outcome rejected');

  -- TC10: with the first task closed a new one can be opened; cancelling it logs task_cancelled.
  insert into public.lead_tasks (tenant_id, lead_id, title, start_date, due_date, created_by)
  values (t_a, v_lead, 'Send brochure', date '2026-10-06', date '2026-10-06', owner_a) returning * into v_task2;
  select * into v_task2 from public.close_lead_task(t_a, v_lead, v_task2.id, 'cancelled', owner_a);
  select * into v_act from public.lead_activities where lead_id = v_lead and type = 'task_cancelled';
  perform pg_temp.assert_true(v_task2.status = 'cancelled' and pg_temp.activity_count(v_lead, 'task_cancelled') = 1
    and v_act.created_by = owner_a and v_act.summary = 'Task cancelled: Send brochure', 'TC10: task_cancelled logged');

  -- TC11: the closed CHECK — a closed task must carry closed_at/closed_by, an open one must not.
  perform pg_temp.expect_error(format('insert into public.lead_tasks (tenant_id, lead_id, title, start_date, due_date, status, created_by) values (%L, %L, %L, %L, %L, %L, %L)',
    t_a, v_lead, 'Bad', '2026-10-05', '2026-10-05', 'completed', owner_a), '23514', 'TC11: closed without closed_* rejected');
  perform pg_temp.expect_error(format('insert into public.lead_tasks (tenant_id, lead_id, title, start_date, due_date, closed_at, closed_by, created_by) values (%L, %L, %L, %L, %L, now(), %L, %L)',
    t_a, v_lead, 'Bad', '2026-10-05', '2026-10-05', owner_a, owner_a), '23514', 'TC11: open with closed_* rejected');

  -- TC12: activities and notes are append-only; deleting the lead cascades everything away.
  perform pg_temp.expect_error(format('update public.lead_activities set summary = %L where lead_id = %L', 'edited', v_lead), '55000', 'TC12: activity update rejected');
  perform pg_temp.expect_error(format('delete from public.lead_activities where lead_id = %L', v_lead), '55000', 'TC12: activity delete rejected');
  perform pg_temp.expect_error(format('update public.lead_notes set body = %L where id = %L', 'edited', v_note_id), '55000', 'TC12: note update rejected');
  perform pg_temp.expect_error(format('delete from public.lead_notes where id = %L', v_note_id), '55000', 'TC12: note delete rejected');
  perform pg_temp.expect_error(format('delete from public.lead_tasks where id = %L', v_task.id), '55000', 'TC12: task delete rejected');

  -- TC13: tenant isolation at the FK — tenant B rows can never point at tenant A's lead.
  perform pg_temp.expect_error(format('insert into public.lead_notes (tenant_id, lead_id, body, created_by) values (%L, %L, %L, %L)', t_b, v_lead, 'cross', owner_b), '23503', 'TC13: cross-tenant note rejected');
  perform pg_temp.expect_error(format('insert into public.lead_tasks (tenant_id, lead_id, title, start_date, due_date, created_by) values (%L, %L, %L, %L, %L, %L)',
    t_b, v_lead, 'cross', '2026-10-05', '2026-10-05', owner_b), '23503', 'TC13: cross-tenant task rejected');

  -- TC12 (cont.): lead delete cascades notes, tasks and activities.
  delete from public.lead_data where id = v_lead;
  perform pg_temp.assert_true(not exists (select 1 from public.lead_activities where lead_id = v_lead)
    and not exists (select 1 from public.lead_notes where lead_id = v_lead)
    and not exists (select 1 from public.lead_tasks where lead_id = v_lead), 'TC12: lead delete cascades');

  -- TC14: grants — the browser roles get nothing; service_role cannot write the timeline directly.
  perform pg_temp.assert_true(not exists (
    select 1 from (values ('anon'), ('authenticated')) as r(role_name),
      (values ('public.lead_notes'), ('public.lead_tasks'), ('public.lead_activities')) as t(table_name),
      (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege)
    where has_table_privilege(r.role_name, t.table_name, p.privilege)
  ), 'TC14: anon/authenticated have no table privileges');
  perform pg_temp.assert_true(has_table_privilege('service_role', 'public.lead_activities', 'SELECT')
    and not has_table_privilege('service_role', 'public.lead_activities', 'INSERT')
    and not has_table_privilege('service_role', 'public.lead_activities', 'UPDATE')
    and not has_table_privilege('service_role', 'public.lead_activities', 'DELETE'), 'TC14: service_role reads but cannot write activities');
  perform pg_temp.assert_true(not has_table_privilege('service_role', 'public.lead_tasks', 'UPDATE')
    and not has_table_privilege('service_role', 'public.lead_tasks', 'DELETE'), 'TC14: service_role cannot update/delete tasks directly');
  perform pg_temp.assert_true(not exists (
    select 1 from (values ('anon'), ('authenticated')) as r(role_name),
      (values ('public.update_lead_status(uuid, uuid, text, uuid)'), ('public.reschedule_lead_task(uuid, uuid, uuid, date, uuid)'),
              ('public.close_lead_task(uuid, uuid, uuid, text, uuid)')) as f(signature)
    where has_function_privilege(r.role_name, f.signature, 'EXECUTE')
  ), 'TC14: browser roles cannot execute the RPCs');

  -- TC15: backfill — every lead has exactly one lead_created row.
  select count(*) into v_count from public.lead_data as ld
  where (select count(*) from public.lead_activities as a where a.lead_id = ld.id and a.type = 'lead_created') <> 1;
  perform pg_temp.assert_true(v_count = 0, 'TC15: every lead has exactly one lead_created');
end;
$$;

-- TC14 (cont.): a signed-in tenant-A user querying directly is refused outright.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"51000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$
begin
  begin
    perform 1 from public.lead_activities limit 1;
    raise exception 'Assertion failed: TC14: authenticated could read lead_activities';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.lead_notes limit 1;
    raise exception 'Assertion failed: TC14: authenticated could read lead_notes';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.lead_tasks limit 1;
    raise exception 'Assertion failed: TC14: authenticated could read lead_tasks';
  exception when insufficient_privilege then null;
  end;
  raise notice 'LEAD_TIMELINE_REGRESSION_PASSED (15 cases; all fixtures rolled back)';
end;
$$;

rollback;
