-- Tasks get a due TIME and a repeat rule (expand step).
--
-- The Add Task form no longer asks for a start date: the task starts when it is created (start_at = now()),
-- and it is due at an exact moment (due_at) chosen as a date + time in the company timezone.
-- original_due_at is the first due time and never changes — the Tasks page measures "on time" against it,
-- so rescheduling cannot turn a late task into an on-time one.
--
-- This is an EXPAND migration: the build that is live while it runs still writes start_date / due_date
-- and still calls reschedule_lead_task(..., p_due_date date, ...). Both keep working:
--   * lead_tasks_a_sync_due fills due_at from due_date (23:59 local) when only the date is written,
--     and fills due_date from due_at when the new build writes the time.
--   * the date overload of reschedule_lead_task stays until the contract migration.
-- The contract migration (after the new build is verified) drops start_date, due_date, the date overload
-- and the sync trigger.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.lead_tasks
  add column start_at timestamptz not null default now(),
  add column due_at timestamptz,
  add column original_due_at timestamptz,
  add column repeat_rule text not null default 'none'
    check (repeat_rule in ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  add column series_id uuid,
  add column series_anchor_at timestamptz,
  add column occurrence_index integer not null default 0 check (occurrence_index >= 0);

-- ---------------------------------------------------------------------------
-- Backfill. Existing tasks become due at 23:59 company time on their due date, so nothing that was "due
-- today" turns overdue on deploy day. The guard, timeline and updated_at triggers stay off for this one
-- statement: it is not a reschedule, must not write timeline rows, and touches closed tasks too.
-- ---------------------------------------------------------------------------
alter table public.lead_tasks disable trigger lead_tasks_guard;
alter table public.lead_tasks disable trigger lead_tasks_log_event;
alter table public.lead_tasks disable trigger lead_tasks_set_updated_at;

update public.lead_tasks as t
set due_at = (t.due_date + time '23:59') at time zone tz.timezone,
    original_due_at = (t.due_date + time '23:59') at time zone tz.timezone,
    start_at = least(t.created_at, (t.due_date + time '23:59') at time zone tz.timezone)
from public.tenants as tz
where tz.tenant_id = t.tenant_id;

alter table public.lead_tasks enable trigger lead_tasks_guard;
alter table public.lead_tasks enable trigger lead_tasks_log_event;
alter table public.lead_tasks enable trigger lead_tasks_set_updated_at;

alter table public.lead_tasks
  alter column due_at set not null,
  alter column original_due_at set not null,
  add constraint lead_tasks_due_after_start_check check (due_at >= start_at),
  add constraint lead_tasks_series_check check (
    repeat_rule = 'none' or (series_id is not null and series_anchor_at is not null)
  );
-- lead_tasks_dates_check (due_date >= start_date) stays: both dates are now the local dates of
-- start_at / due_at, so it follows from lead_tasks_due_after_start_check.

-- Tasks page: open tasks by due time (Today / Upcoming / Overdue, reminders) and completed by close time (Done).
create index lead_tasks_open_due_idx on public.lead_tasks (tenant_id, due_at) where status = 'open';
create index lead_tasks_completed_idx on public.lead_tasks (tenant_id, closed_at desc) where status = 'completed';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The company timezone exactly as stored (validated IANA name, never null).
create or replace function public.lead_task_tenant_timezone(p_tenant_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select t.timezone from public.tenants as t where t.tenant_id = p_tenant_id;
$$;

-- "08 Oct 2026, 11:00 PM" in the company timezone.
create or replace function public.lead_task_due_label(p_due_at timestamptz, p_timezone text)
returns text language sql stable set search_path = '' as $$
  select pg_catalog.to_char(p_due_at at time zone p_timezone, 'DD Mon YYYY, FMHH12:MI AM');
$$;

revoke all on function public.lead_task_tenant_timezone(uuid) from public, anon, authenticated;
revoke all on function public.lead_task_due_label(timestamptz, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Two-way sync between the date columns (old build) and due_at / start_at (new build).
-- Named "a_sync" so it fires before lead_tasks_guard and lead_tasks_set_updated_at: same-timing
-- triggers fire in name order, and the guard must see the synced row.
-- ---------------------------------------------------------------------------
create or replace function public.sync_lead_task_due()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_timezone text := public.lead_task_tenant_timezone(new.tenant_id);
begin
  if TG_OP = 'INSERT' then
    if new.due_at is null and new.due_date is not null then
      -- Old build: date only, due at the end of that day.
      new.due_at := (new.due_date + time '23:59') at time zone v_timezone;
    elsif new.due_at is not null then
      new.due_date := (new.due_at at time zone v_timezone)::date;
    end if;
    -- The task starts when it is created. An old-build task may be due earlier today (or, as before, on a
    -- past date): it then starts at its due time so the start never lies after the due.
    new.start_at := least(now(), new.due_at);
    if new.start_date is null then
      new.start_date := (new.start_at at time zone v_timezone)::date;
    end if;
    new.original_due_at := new.due_at;
    if new.repeat_rule <> 'none' then
      new.series_id := coalesce(new.series_id, new.id);
      new.series_anchor_at := coalesce(new.series_anchor_at, new.due_at);
    end if;
  elsif new.due_at is distinct from old.due_at then
    new.due_date := (new.due_at at time zone v_timezone)::date;
  elsif new.due_date is distinct from old.due_date then
    new.due_at := (new.due_date + time '23:59') at time zone v_timezone;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_lead_task_due() from public, anon, authenticated;

create trigger lead_tasks_a_sync_due before insert or update on public.lead_tasks
  for each row execute function public.sync_lead_task_due();

-- ---------------------------------------------------------------------------
-- Guard: an open task may only be rescheduled (due_at, with its synced due_date) or closed.
-- ---------------------------------------------------------------------------
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
     or new.start_at is distinct from old.start_at
     or new.original_due_at is distinct from old.original_due_at
     or new.repeat_rule is distinct from old.repeat_rule
     or new.series_id is distinct from old.series_id
     or new.series_anchor_at is distinct from old.series_anchor_at
     or new.occurrence_index is distinct from old.occurrence_index
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Only the due date of an open task can be changed' using errcode = '55000';
  end if;

  -- Exactly two kinds of change: reschedule (still open, due only) or close (due untouched).
  if new.status <> 'open'
     and (new.due_at is distinct from old.due_at or new.due_date is distinct from old.due_date) then
    raise exception 'A task cannot be rescheduled and closed in the same change' using errcode = '55000';
  end if;
  if new.status = 'open' and (new.closed_at is not null or new.closed_by is not null) then
    raise exception 'An open task cannot carry closing details' using errcode = '55000';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Timeline rows now carry the due time (company timezone) and the repeat rule.
-- Existing timeline rows are left as they were written.
-- ---------------------------------------------------------------------------
create or replace function public.log_lead_task_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_timezone text := public.lead_task_tenant_timezone(new.tenant_id);
begin
  if TG_OP = 'INSERT' then
    insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
    values (
      new.tenant_id, new.lead_id, 'task_created',
      'Task: ' || new.title || ' · due ' || public.lead_task_due_label(new.due_at, v_timezone)
        || case when new.repeat_rule <> 'none' then ' · repeats ' || new.repeat_rule else '' end,
      pg_catalog.jsonb_build_object(
        'task_id', new.id, 'title', new.title, 'start_date', new.start_date, 'due_date', new.due_date,
        'due_at', new.due_at, 'repeat_rule', new.repeat_rule
      ),
      new.created_by
    );
  elsif old.status = 'open' and new.status = 'open' and new.due_at is distinct from old.due_at then
    insert into public.lead_activities (tenant_id, lead_id, type, summary, metadata, created_by)
    values (
      new.tenant_id, new.lead_id, 'task_rescheduled',
      'Task rescheduled: ' || new.title || ' · ' || public.lead_task_due_label(old.due_at, v_timezone)
        || ' → ' || public.lead_task_due_label(new.due_at, v_timezone),
      pg_catalog.jsonb_build_object(
        'task_id', new.id, 'title', new.title, 'old', old.due_date, 'new', new.due_date,
        'old_due_at', old.due_at, 'new_due_at', new.due_at
      ),
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

revoke all on function public.log_lead_task_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reschedule to an exact time. Must lie in the future. The date overload stays for the old build.
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_lead_task(
  p_tenant_id uuid, p_lead_id uuid, p_task_id uuid, p_due_at timestamptz, p_actor_user_id uuid
)
returns setof public.lead_tasks
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_active_tenant_member(p_tenant_id, p_actor_user_id);
  if p_due_at is null then
    raise exception 'A due time is required' using errcode = '22023';
  end if;
  if p_due_at <= now() then
    raise exception 'The due time must be in the future' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('app.current_user_id', p_actor_user_id::text, true);
  return query
    with updated as (
      update public.lead_tasks as t
      set due_at = p_due_at
      where t.tenant_id = p_tenant_id and t.lead_id = p_lead_id and t.id = p_task_id
      returning t.*
    )
    select * from updated;
  perform pg_catalog.set_config('app.current_user_id', '', true);
end;
$$;

revoke all on function public.reschedule_lead_task(uuid, uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.reschedule_lead_task(uuid, uuid, uuid, timestamptz, uuid) to service_role;

notify pgrst, 'reload schema';
