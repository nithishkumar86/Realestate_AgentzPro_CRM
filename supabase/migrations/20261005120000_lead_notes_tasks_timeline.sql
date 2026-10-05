-- Lead Timeline: append-only per-lead history, plus the minimal notes and follow-up tasks it shows.
--
-- 1. lead_notes      — telecaller notes. Immutable once written.
-- 2. lead_tasks      — follow-up tasks. At most ONE open task per lead. While open only due_date may change
--                      (reschedule); closing (completed | cancelled) is final.
-- 3. lead_activities — the timeline. Written ONLY by the trigger functions below, in the same transaction as
--                      the change it records, so history can never drift from the data. Never updated; rows go
--                      away only through the FK cascade when the lead (or tenant) is deleted.
--
-- Access model matches lead_data: RLS enabled and forced, no policies, nothing granted to anon/authenticated.
-- The browser never reads these tables; Next API routes do, as service_role, pinned to the tenant from the
-- verified session (src/lib/server/tenant-context.ts).
--
-- Actor: every write arrives as service_role, so auth.uid() is NULL inside triggers. Who did it is therefore
-- carried explicitly — created_by / closed_by columns written by the server, or the transaction-local
-- app.current_user_id setting (the same pattern as audit_lead_project_assignment in
-- 20260902120000_lead_projects_and_search.sql) set by the service-role-only RPCs at the end of this file.
-- Actor columns are plain uuids with no FK to auth.users: an `on delete set null` FK would be an UPDATE that
-- the immutability guards below must reject. A removed user simply renders as "Former team member".
--
-- Timeline scope (product decision): lead_created, status changes, notes and task events. Label
-- (Hot/Warm/Cold/Not Interested) changes are deliberately NOT logged.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  lead_id uuid not null,
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint lead_notes_lead_fk foreign key (tenant_id, lead_id)
    references public.lead_data(tenant_id, id) on delete cascade
);
create index lead_notes_lead_idx on public.lead_notes (tenant_id, lead_id, created_at desc);

create table public.lead_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  lead_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  start_date date not null,
  due_date date not null,
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  closed_at timestamptz,
  closed_by uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_tasks_dates_check check (due_date >= start_date),
  constraint lead_tasks_closed_check check (
    (status = 'open' and closed_at is null and closed_by is null)
    or (status in ('completed', 'cancelled') and closed_at is not null and closed_by is not null)
  ),
  constraint lead_tasks_lead_fk foreign key (tenant_id, lead_id)
    references public.lead_data(tenant_id, id) on delete cascade
);
-- One open task per lead. Also the index behind the leads table's "no open task" lookup.
create unique index lead_tasks_one_open_per_lead_idx on public.lead_tasks (tenant_id, lead_id) where status = 'open';
create index lead_tasks_lead_idx on public.lead_tasks (tenant_id, lead_id, created_at desc);

create trigger lead_tasks_set_updated_at before update on public.lead_tasks
  for each row execute function public.set_updated_at();

create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  lead_id uuid not null,
  type text not null check (type in (
    'lead_created', 'status_change', 'note_added',
    'task_created', 'task_rescheduled', 'task_completed', 'task_cancelled'
  )),
  summary text not null check (length(summary) between 1 and 500),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  -- NULL = System (lead ingestion, or a status change made outside update_lead_status).
  created_by uuid,
  -- clock_timestamp(), not now(): two events in one transaction must still order correctly.
  created_at timestamptz not null default clock_timestamp(),
  constraint lead_activities_lead_fk foreign key (tenant_id, lead_id)
    references public.lead_data(tenant_id, id) on delete cascade
);
-- Keyset pagination: newest first, id as the tie-breaker.
create index lead_activities_timeline_idx on public.lead_activities (tenant_id, lead_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Row Level Security and grants
-- ---------------------------------------------------------------------------
alter table public.lead_notes enable row level security;
alter table public.lead_notes force row level security;
alter table public.lead_tasks enable row level security;
alter table public.lead_tasks force row level security;
alter table public.lead_activities enable row level security;
alter table public.lead_activities force row level security;

revoke all on table public.lead_notes, public.lead_tasks, public.lead_activities from public, anon, authenticated;
grant select, insert on table public.lead_notes to service_role;
-- No UPDATE: every task change goes through reschedule_lead_task / close_lead_task.
grant select, insert on table public.lead_tasks to service_role;
-- Read only: rows are written exclusively by the trigger functions below.
grant select on table public.lead_activities to service_role;

-- ---------------------------------------------------------------------------
-- Immutability guards. Triggers fire for every role, including the table owner, so these hold even from the
-- SQL editor. DELETE is allowed only when it arrives through an FK cascade (lead or tenant deleted, e.g. the
-- Meta data-deletion flow): the cascade runs inside the RI trigger, so pg_trigger_depth() is > 1.
-- ---------------------------------------------------------------------------
create or replace function public.reject_append_only_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'DELETE' then
    if pg_catalog.pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception '% rows can only be removed together with their lead', TG_TABLE_NAME using errcode = '55000';
  end if;
  raise exception '% rows are append-only and cannot be changed', TG_TABLE_NAME using errcode = '55000';
end;
$$;

create trigger lead_activities_append_only before update or delete on public.lead_activities
  for each row execute function public.reject_append_only_change();
create trigger lead_notes_append_only before update or delete on public.lead_notes
  for each row execute function public.reject_append_only_change();

create or replace function public.guard_lead_task_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'DELETE' then
    if pg_catalog.pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'Tasks can only be removed together with their lead' using errcode = '55000';
  end if;

  if old.status <> 'open' then
    raise exception 'This task is already closed and cannot be changed' using errcode = '55000';
  end if;

  if new.tenant_id is distinct from old.tenant_id
     or new.lead_id is distinct from old.lead_id
     or new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.start_date is distinct from old.start_date
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Only the due date of an open task can be changed' using errcode = '55000';
  end if;

  -- Exactly two kinds of change: reschedule (still open, due_date only) or close (due_date untouched).
  if new.status <> 'open' and new.due_date is distinct from old.due_date then
    raise exception 'A task cannot be rescheduled and closed in the same change' using errcode = '55000';
  end if;
  if new.status = 'open' and (new.closed_at is not null or new.closed_by is not null) then
    raise exception 'An open task cannot carry closing details' using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger lead_tasks_guard before update or delete on public.lead_tasks
  for each row execute function public.guard_lead_task_change();

revoke all on function public.reject_append_only_change() from public, anon, authenticated;
revoke all on function public.guard_lead_task_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Timeline writers. AFTER triggers, so a timeline row exists if and only if the change committed.
-- ---------------------------------------------------------------------------

-- The actor set by update_lead_status / reschedule_lead_task, or NULL. Never raises: a malformed value must
-- not be able to block a status change, it just records System.
create or replace function public.current_timeline_actor()
returns uuid language plpgsql stable set search_path = '' as $$
declare v_raw text := nullif(pg_catalog.current_setting('app.current_user_id', true), '');
begin
  if v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v_raw::uuid;
  end if;
  return null;
end;
$$;
revoke all on function public.current_timeline_actor() from public, anon, authenticated;

create or replace function public.log_lead_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by, created_at)
  values (
    new.tenant_id, new.id, 'lead_created',
    'Lead created · Status: ' || new.status,
    pg_catalog.jsonb_build_object('status', new.status),
    null,
    least(coalesce(new.lead_created_time, pg_catalog.clock_timestamp()), pg_catalog.clock_timestamp())
  );
  return null;
end;
$$;

create or replace function public.log_lead_status_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
  values (
    new.tenant_id, new.id, 'status_change',
    'Status: ' || old.status || ' → ' || new.status,
    pg_catalog.jsonb_build_object('old', old.status, 'new', new.status),
    public.current_timeline_actor()
  );
  return null;
end;
$$;

create or replace function public.log_lead_note_added()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_text text := pg_catalog.regexp_replace(pg_catalog.btrim(new.body), '\s+', ' ', 'g');
begin
  insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
  values (
    new.tenant_id, new.lead_id, 'note_added',
    case when pg_catalog.length(v_text) > 120 then pg_catalog.left(v_text, 120) || '…' else v_text end,
    pg_catalog.jsonb_build_object('note_id', new.id),
    new.created_by
  );
  return null;
end;
$$;

create or replace function public.log_lead_task_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
    values (
      new.tenant_id, new.lead_id, 'task_created',
      'Task: ' || new.title || ' · due ' || pg_catalog.to_char(new.due_date, 'DD Mon YYYY'),
      pg_catalog.jsonb_build_object('task_id', new.id, 'title', new.title, 'start_date', new.start_date, 'due_date', new.due_date),
      new.created_by
    );
  elsif old.status = 'open' and new.status = 'open' and new.due_date is distinct from old.due_date then
    insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
    values (
      new.tenant_id, new.lead_id, 'task_rescheduled',
      'Task rescheduled: ' || new.title || ' · ' || pg_catalog.to_char(old.due_date, 'DD Mon YYYY') || ' → ' || pg_catalog.to_char(new.due_date, 'DD Mon YYYY'),
      pg_catalog.jsonb_build_object('task_id', new.id, 'title', new.title, 'old', old.due_date, 'new', new.due_date),
      public.current_timeline_actor()
    );
  elsif old.status = 'open' and new.status in ('completed', 'cancelled') then
    insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
    values (
      new.tenant_id, new.lead_id,
      case new.status when 'completed' then 'task_completed' else 'task_cancelled' end,
      case new.status when 'completed' then 'Task completed: ' else 'Task cancelled: ' end || new.title,
      pg_catalog.jsonb_build_object('task_id', new.id, 'title', new.title),
      new.closed_by
    );
  end if;
  return null;
end;
$$;

revoke all on function public.log_lead_created() from public, anon, authenticated;
revoke all on function public.log_lead_status_change() from public, anon, authenticated;
revoke all on function public.log_lead_note_added() from public, anon, authenticated;
revoke all on function public.log_lead_task_event() from public, anon, authenticated;

-- Creating these takes a lock on lead_data that holds until this migration commits: a lead arriving
-- meanwhile waits, then fires the new trigger — so the backfill below can neither miss nor double a lead.
create trigger lead_data_log_created after insert on public.lead_data
  for each row execute function public.log_lead_created();
create trigger lead_data_log_status_change after update of status on public.lead_data
  for each row when (old.status is distinct from new.status)
  execute function public.log_lead_status_change();
create trigger lead_notes_log_added after insert on public.lead_notes
  for each row execute function public.log_lead_note_added();
create trigger lead_tasks_log_event after insert or update on public.lead_tasks
  for each row execute function public.log_lead_task_event();

-- ---------------------------------------------------------------------------
-- Backfill: one lead_created row per existing lead. Earlier status history was never recorded and cannot be
-- reconstructed; the UI says so on rows marked backfilled. Every lead was inserted with the column default
-- 'New Lead'. lead_created_time is NOT NULL by schema; the coalesce is only a safety net.
-- ---------------------------------------------------------------------------
insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by, created_at)
select ld.tenant_id, ld.id, 'lead_created', 'Lead created · Status: New Lead',
       pg_catalog.jsonb_build_object('status', 'New Lead', 'backfilled', true), null,
       coalesce(ld.lead_created_time, now())
from public.lead_data as ld;

-- ---------------------------------------------------------------------------
-- Live signal: one PII-free broadcast per (tenant, lead) per statement on the existing private topic
-- "dashboard:<tenant_id>" (see 20260929120000_dashboard_stats_and_live_signal.sql). Only the server relays it
-- to the tenant's own SSE streams. Errors are swallowed so Realtime can never fail a write. Created after the
-- backfill so the backfill does not broadcast.
-- ---------------------------------------------------------------------------
create or replace function public.notify_lead_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row record;
begin
  begin
    for v_row in select distinct tenant_id, lead_id from new_rows loop
      perform realtime.send(pg_catalog.jsonb_build_object('lead_id', v_row.lead_id), 'lead_activity', 'dashboard:' || v_row.tenant_id::text, true);
    end loop;
  exception when others then
    null; -- never let the live signal fail a timeline write
  end;
  return null;
end;
$$;
revoke all on function public.notify_lead_activity() from public, anon, authenticated;

create trigger lead_activities_notify after insert on public.lead_activities
  referencing new table as new_rows
  for each statement execute function public.notify_lead_activity();

-- ---------------------------------------------------------------------------
-- Service-role RPCs. The caller (a Next API route) has already verified the session and tenant; these
-- re-check that the actor is an ACTIVE member of that tenant so a wrong id can never be attributed.
-- Rows are matched by tenant + lead + id only — never by status — so acting on a closed task reaches the
-- guard and fails with 55000 (surfaced as 409 TASK_ALREADY_CLOSED) instead of silently matching nothing.
-- ---------------------------------------------------------------------------
create or replace function public.assert_active_tenant_member(p_tenant_id uuid, p_user_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_tenant_id is null or p_user_id is null then
    raise exception 'Tenant and actor are required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.tenant_memberships as m
    where m.tenant_id = p_tenant_id and m.user_id = p_user_id and m.membership_status = 'active'
  ) then
    raise exception 'Actor is not an active member of this tenant' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.assert_active_tenant_member(uuid, uuid) from public, anon, authenticated;

create or replace function public.update_lead_status(
  p_tenant_id uuid, p_lead_id uuid, p_status text, p_actor_user_id uuid
)
returns table (lead_id uuid, lead_status text, lead_label text, lead_label_source text)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_active_tenant_member(p_tenant_id, p_actor_user_id);
  perform pg_catalog.set_config('app.current_user_id', p_actor_user_id::text, true);
  return query
    with updated as (
      update public.lead_data as ld
      set status = p_status
      where ld.tenant_id = p_tenant_id and ld.id = p_lead_id
      returning ld.id, ld.status, ld.label, ld.label_source
    )
    select updated.id, updated.status, updated.label, updated.label_source from updated;
  perform pg_catalog.set_config('app.current_user_id', '', true);
end;
$$;

create or replace function public.reschedule_lead_task(
  p_tenant_id uuid, p_lead_id uuid, p_task_id uuid, p_due_date date, p_actor_user_id uuid
)
returns setof public.lead_tasks
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_active_tenant_member(p_tenant_id, p_actor_user_id);
  if p_due_date is null then
    raise exception 'A due date is required' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('app.current_user_id', p_actor_user_id::text, true);
  return query
    with updated as (
      update public.lead_tasks as t
      set due_date = p_due_date
      where t.tenant_id = p_tenant_id and t.lead_id = p_lead_id and t.id = p_task_id
      returning t.*
    )
    select * from updated;
  perform pg_catalog.set_config('app.current_user_id', '', true);
end;
$$;

create or replace function public.close_lead_task(
  p_tenant_id uuid, p_lead_id uuid, p_task_id uuid, p_outcome text, p_actor_user_id uuid
)
returns setof public.lead_tasks
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_active_tenant_member(p_tenant_id, p_actor_user_id);
  if p_outcome is null or p_outcome not in ('completed', 'cancelled') then
    raise exception 'Outcome must be completed or cancelled' using errcode = '22023';
  end if;
  return query
    with updated as (
      update public.lead_tasks as t
      set status = p_outcome, closed_at = now(), closed_by = p_actor_user_id
      where t.tenant_id = p_tenant_id and t.lead_id = p_lead_id and t.id = p_task_id
      returning t.*
    )
    select * from updated;
end;
$$;

revoke all on function public.update_lead_status(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.reschedule_lead_task(uuid, uuid, uuid, date, uuid) from public, anon, authenticated;
revoke all on function public.close_lead_task(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.update_lead_status(uuid, uuid, text, uuid) to service_role;
grant execute on function public.reschedule_lead_task(uuid, uuid, uuid, date, uuid) to service_role;
grant execute on function public.close_lead_task(uuid, uuid, uuid, text, uuid) to service_role;
