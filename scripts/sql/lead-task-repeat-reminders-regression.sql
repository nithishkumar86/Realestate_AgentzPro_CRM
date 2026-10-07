-- Regression for supabase/migrations/20261007130000_lead_task_repeat_tracking_reminders.sql:
-- repeat anchoring (31st, leap year, late completion, reschedule does not shift the series), cancel ends
-- the series, non-repeating close unchanged, task owner fallback (blocked assignee), Tasks page buckets and
-- counts, reminder idempotency and tenant isolation, grants.
--
-- One transaction ending in ROLLBACK. A clean run ends with the NOTICE 'TASK_REPEAT_REMINDERS_PASSED'.
begin;
set local statement_timeout = '60s';

create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %', message; end if; end;
$$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('52000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'repeat-owner-a@repeat.test'),
  ('52000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'repeat-blocked-a@repeat.test'),
  ('52000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'repeat-emp-a@repeat.test'),
  ('52000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'repeat-owner-b@repeat.test');
insert into public.tenants (tenant_id, tenant_name, timezone) values
  ('52000000-0000-0000-0000-000000000001', 'Repeat Regression A', 'Asia/Kolkata'),
  ('52000000-0000-0000-0000-000000000002', 'Repeat Regression B', 'Asia/Kolkata');
insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status) values
  ('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-0000000000a1', 'owner', 'active'),
  ('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-0000000000a2', 'employee', 'blocked'),
  ('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-0000000000a3', 'employee', 'active'),
  ('52000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-0000000000b1', 'owner', 'active');
insert into public.meta_connections (id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted)
values ('52000000-0000-0000-0000-000000000003', '52000000-0000-0000-0000-000000000001', 'repeat-user', 'fixture'),
       ('52000000-0000-0000-0000-000000000013', '52000000-0000-0000-0000-000000000002', 'repeat-user-b', 'fixture');
insert into public.facebook_pages (id, tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, page_access_token_encrypted, connected_at)
values ('52000000-0000-0000-0000-000000000004', '52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000003', 'repeat-page', 'Repeat Page', 'fixture', now() - interval '1 day'),
       ('52000000-0000-0000-0000-000000000014', '52000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000013', 'repeat-page-b', 'Repeat Page B', 'fixture', now() - interval '1 day');

-- One lead through the real webhook -> claim -> complete chain.
create function pg_temp.new_lead(p_tenant uuid, p_page uuid, p_page_id text) returns uuid language plpgsql as $$
declare v_event uuid; v_claimed public.meta_webhook_notification_events; v_lead uuid;
begin
  insert into public.meta_webhook_notification_events (tenant_id, facebook_page_record_id, facebook_page_id,
    meta_entry_id, meta_entry_time, leadgen_id, form_id, lead_created_time, raw_webhook_change)
  values (p_tenant, p_page, p_page_id, 'entry', now(), gen_random_uuid()::text, 'form', now(), '{}')
  returning id into v_event;
  select * into v_claimed from public.claim_meta_webhook_notification_event(v_event);
  perform public.complete_meta_lead_retrieval_event(v_event, v_claimed.claim_token, '[]', null, '{}', now(), null);
  select id into v_lead from public.lead_data where webhook_notification_event_id = v_event;
  return v_lead;
end;
$$;

create function pg_temp.lead_a() returns uuid language sql as $$
  select pg_temp.new_lead('52000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000004', 'repeat-page');
$$;

create function pg_temp.task(p_lead uuid, p_due timestamptz, p_rule text, p_by uuid) returns public.lead_tasks language sql as $$
  insert into public.lead_tasks (tenant_id, lead_id, title, start_at, due_at, repeat_rule, created_by)
  values ('52000000-0000-0000-0000-000000000001', p_lead, 'Call back', least(now(), p_due), p_due, p_rule, p_by)
  returning *;
$$;

do $$
declare
  t_a constant uuid := '52000000-0000-0000-0000-000000000001';
  t_b constant uuid := '52000000-0000-0000-0000-000000000002';
  owner_a constant uuid := '52000000-0000-0000-0000-0000000000a1';
  blocked_a constant uuid := '52000000-0000-0000-0000-0000000000a2';
  emp_a constant uuid := '52000000-0000-0000-0000-0000000000a3';
  ist constant text := 'Asia/Kolkata';
  v_lead uuid;
  v_lead2 uuid;
  v_task public.lead_tasks;
  v_next public.lead_tasks;
  v_closed public.lead_tasks;
  v_due timestamptz;
  v_idx integer;
  v_count bigint;
  v_counts record;
begin
  -- R1: monthly from the 31st clamps per month and never drifts (31 Jan -> 28 Feb -> 31 Mar).
  select next_due into v_due from public.lead_task_next_due('2027-01-31 10:00+05:30', 'monthly', 1, ist);
  perform pg_temp.assert_true(v_due = '2027-02-28 10:00+05:30', 'R1: 31 Jan + 1 month = 28 Feb');
  select next_due into v_due from public.lead_task_next_due('2027-01-31 10:00+05:30', 'monthly', 2, ist);
  perform pg_temp.assert_true(v_due = '2027-03-31 10:00+05:30', 'R1: 31 Jan + 2 months = 31 Mar (no drift)');

  -- R2: yearly from 29 Feb.
  select next_due into v_due from public.lead_task_next_due('2028-02-29 09:00+05:30', 'yearly', 1, ist);
  perform pg_temp.assert_true(v_due = '2029-02-28 09:00+05:30', 'R2: 29 Feb + 1 year = 28 Feb');
  select next_due into v_due from public.lead_task_next_due('2028-02-29 09:00+05:30', 'yearly', 4, ist);
  perform pg_temp.assert_true(v_due = '2032-02-29 09:00+05:30', 'R2: 29 Feb + 4 years = 29 Feb');

  -- R3: completing late skips the missed occurrences; the next one is the first in the future.
  select next_due, next_index into v_due, v_idx
  from public.lead_task_next_due(now() - interval '10 days' + interval '1 hour', 'daily', 1, ist);
  perform pg_temp.assert_true(v_idx = 10 and v_due = now() + interval '1 hour', 'R3: late completion jumps to occurrence 10');
  perform pg_temp.assert_true(v_due > now(), 'R3: next occurrence is in the future');

  -- R4: completing a weekly task returns the closed row and opens the next occurrence of the series.
  v_lead := pg_temp.lead_a();
  v_task := pg_temp.task(v_lead, now() + interval '2 hours', 'weekly', owner_a);
  perform pg_temp.assert_true(v_task.series_id = v_task.id and v_task.series_anchor_at = v_task.due_at, 'R4: series anchored on insert');
  select count(*) into v_count from public.close_lead_task(t_a, v_lead, v_task.id, 'completed', emp_a);
  perform pg_temp.assert_true(v_count = 1, 'R4: close returns exactly one row');
  select * into v_closed from public.lead_tasks where id = v_task.id;
  perform pg_temp.assert_true(v_closed.status = 'completed' and v_closed.closed_by = emp_a, 'R4: old row completed');
  select * into v_next from public.lead_tasks where lead_id = v_lead and status = 'open';
  perform pg_temp.assert_true(v_next.id is not null and v_next.id <> v_task.id, 'R4: next occurrence opened');
  perform pg_temp.assert_true(v_next.due_at = v_task.due_at + interval '7 days', 'R4: due one week after the anchor');
  perform pg_temp.assert_true(v_next.series_id = v_task.id and v_next.series_anchor_at = v_task.series_anchor_at
    and v_next.occurrence_index = 1 and v_next.repeat_rule = 'weekly' and v_next.title = v_task.title
    and v_next.created_by = owner_a and v_next.original_due_at = v_next.due_at
    and v_next.due_date = (v_next.due_at at time zone ist)::date, 'R4: next occurrence carries the series');
  select count(*) into v_count from public.lead_activities where lead_id = v_lead and type = 'task_created';
  perform pg_temp.assert_true(v_count = 2, 'R4: next occurrence logged on the timeline');

  -- R5: rescheduling one occurrence does not shift the series.
  perform public.reschedule_lead_task(t_a, v_lead, v_next.id, v_next.due_at + interval '3 days', owner_a);
  perform public.close_lead_task(t_a, v_lead, v_next.id, 'completed', owner_a);
  select * into v_task from public.lead_tasks where lead_id = v_lead and status = 'open';
  perform pg_temp.assert_true(v_task.occurrence_index = 2 and v_task.due_at = v_closed.series_anchor_at + interval '14 days',
    'R5: occurrence 2 still anchor + 2 weeks');

  -- R6: cancel ends the series.
  perform public.close_lead_task(t_a, v_lead, v_task.id, 'cancelled', owner_a);
  select count(*) into v_count from public.lead_tasks where lead_id = v_lead and status = 'open';
  perform pg_temp.assert_true(v_count = 0, 'R6: cancel opens no next occurrence');

  -- R7: a non-repeating task closes exactly as before.
  v_task := pg_temp.task(v_lead, now() + interval '1 day', 'none', owner_a);
  select * into v_closed from public.close_lead_task(t_a, v_lead, v_task.id, 'completed', owner_a);
  perform pg_temp.assert_true(v_closed.id = v_task.id and v_closed.status = 'completed', 'R7: closed row returned');
  select count(*) into v_count from public.lead_tasks where lead_id = v_lead and status = 'open';
  perform pg_temp.assert_true(v_count = 0, 'R7: no next occurrence');

  -- R8: owner = assignee, else creator when the assignee is blocked, else the company owner.
  perform pg_temp.assert_true(public.lead_task_owner(t_a, emp_a, owner_a) = emp_a, 'R8: active assignee');
  perform pg_temp.assert_true(public.lead_task_owner(t_a, blocked_a, emp_a) = emp_a, 'R8: blocked assignee -> creator');
  perform pg_temp.assert_true(public.lead_task_owner(t_a, blocked_a, blocked_a) = owner_a, 'R8: both blocked -> owner');
  perform pg_temp.assert_true(public.lead_task_owner(t_a, null, emp_a) = emp_a, 'R8: unassigned -> creator');

  -- R9: buckets do not overlap; employee scope sees only their own tasks.
  update public.lead_data set assigned_user_id = emp_a where id = v_lead;
  v_task := pg_temp.task(v_lead, now() + interval '10 minutes', 'none', owner_a);   -- emp_a's (assignee)
  v_lead2 := pg_temp.lead_a();
  perform pg_temp.task(v_lead2, now() - interval '30 minutes', 'none', owner_a);    -- owner_a's, overdue
  select count(*) into v_count from public.list_tracked_tasks(t_a, 'overdue', null);
  perform pg_temp.assert_true(v_count = 1, 'R9: one overdue');
  select count(*) into v_count from public.list_tracked_tasks(t_a, 'overdue', emp_a);
  perform pg_temp.assert_true(v_count = 0, 'R9: employee does not see the owner''s overdue task');
  select * into v_counts from public.count_tracked_tasks(t_a, emp_a);
  perform pg_temp.assert_true(v_counts.overdue = 0 and v_counts.today + v_counts.upcoming = 1, 'R9: employee counts');
  select * into v_counts from public.count_tracked_tasks(t_a, null);
  perform pg_temp.assert_true(v_counts.overdue = 1 and v_counts.done = 3 and v_counts.done_on_time = 3, 'R9: owner counts incl. done on time');
  select count(*) into v_count from public.list_tracked_tasks(t_a, 'done', null, now() - interval '1 day', now() + interval '1 minute');
  perform pg_temp.assert_true(v_count = 3, 'R9: done list (completed only, cancelled excluded)');

  -- R10: reminders. Tenant B run touches nothing in A; A's run creates due_soon for emp_a and due_now
  -- for the overdue task; a second run creates nothing.
  select count(*) into v_count from public.enqueue_task_reminders(t_b);
  perform pg_temp.assert_true(v_count = 0, 'R10: tenant-scoped run ignores other companies');
  select count(*) into v_count from public.enqueue_task_reminders(t_a);
  perform pg_temp.assert_true(v_count = 2, 'R10: due_soon + due_now created');
  perform pg_temp.assert_true(exists (select 1 from public.task_notifications
    where task_id = v_task.id and kind = 'due_soon' and user_id = emp_a and tenant_id = t_a), 'R10: due_soon goes to the assignee');
  select count(*) into v_count from public.enqueue_task_reminders(t_a);
  perform pg_temp.assert_true(v_count = 0, 'R10: second run is idempotent');

  -- R11: rescheduling gives fresh reminders for the new due time.
  perform public.reschedule_lead_task(t_a, v_lead, v_task.id, now() + interval '5 minutes', owner_a);
  select count(*) into v_count from public.enqueue_task_reminders(t_a);
  perform pg_temp.assert_true(v_count = 1, 'R11: rescheduled task alerts again');

  -- R12: browser roles cannot reach the new tables or functions.
  perform pg_temp.assert_true(not has_table_privilege('authenticated', 'public.task_notifications', 'select')
    and not has_table_privilege('authenticated', 'public.push_subscriptions', 'select')
    and not has_function_privilege('authenticated', 'public.enqueue_task_reminders(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_tracked_tasks(uuid,text,uuid,timestamptz,timestamptz,integer,integer)', 'execute')
    and has_function_privilege('service_role', 'public.close_lead_task(uuid,uuid,uuid,text,uuid)', 'execute'), 'R12: grants');

  raise notice 'TASK_REPEAT_REMINDERS_PASSED (12 cases; all fixtures rolled back)';
end;
$$;

rollback;
