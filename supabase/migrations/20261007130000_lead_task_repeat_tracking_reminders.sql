-- Repeating tasks, the Tasks page and task reminders (additive; safe while the current build is live).
--
-- 1. close_lead_task: completing a repeating task opens its next occurrence in the same transaction.
--    The next due time is computed from the series anchor (anchor + n x step on the company clock), so
--    monthly tasks never drift (31 Jan -> 28 Feb -> 31 Mar) and rescheduling one occurrence never shifts
--    the series. Cancel ends the series. For non-repeating tasks the function behaves exactly as before.
-- 2. lead_task_owner(): "whose task is this" — the lead's assignee, else the task creator, skipping
--    blocked members, else the company owner. The Tasks page scope and the reminder recipient use it,
--    so they never disagree.
-- 3. task_notifications + enqueue_task_reminders(): 15 minutes before and at the due time.
-- 4. push_subscriptions: browser push endpoints per user.

-- ---------------------------------------------------------------------------
-- 1. Repeat
-- ---------------------------------------------------------------------------
create or replace function public.lead_task_next_due(
  p_anchor timestamptz, p_rule text, p_from_index integer, p_timezone text,
  out next_due timestamptz, out next_index integer
)
language plpgsql stable set search_path = '' as $$
declare
  v_step interval := case p_rule
    when 'daily' then interval '1 day' when 'weekly' then interval '7 days'
    when 'monthly' then interval '1 month' when 'yearly' then interval '1 year' end;
  v_local timestamp := p_anchor at time zone p_timezone;
  v_guard integer := 0;
begin
  if v_step is null then
    raise exception 'Unknown repeat rule %', p_rule using errcode = '22023';
  end if;
  next_index := greatest(p_from_index, 1);
  loop
    -- Anchor + n steps in one go (never step-by-step from the previous due), on the company clock.
    next_due := (v_local + v_step * next_index) at time zone p_timezone;
    exit when next_due > now();
    next_index := next_index + 1;
    v_guard := v_guard + 1;
    if v_guard > 100000 then
      raise exception 'Could not find the next occurrence' using errcode = '22023';
    end if;
  end loop;
end;
$$;

revoke all on function public.lead_task_next_due(timestamptz, text, integer, text) from public, anon, authenticated;

create or replace function public.close_lead_task(
  p_tenant_id uuid, p_lead_id uuid, p_task_id uuid, p_outcome text, p_actor_user_id uuid
)
returns setof public.lead_tasks
language plpgsql security definer set search_path = '' as $$
declare
  v_closed public.lead_tasks;
  v_next record;
begin
  perform public.assert_active_tenant_member(p_tenant_id, p_actor_user_id);
  if p_outcome is null or p_outcome not in ('completed', 'cancelled') then
    raise exception 'Outcome must be completed or cancelled' using errcode = '22023';
  end if;

  -- Two statements, not one CTE: the old row must be closed before the next occurrence is inserted,
  -- or the one-open-task-per-lead index would reject it.
  update public.lead_tasks as t
  set status = p_outcome, closed_at = now(), closed_by = p_actor_user_id
  where t.tenant_id = p_tenant_id and t.lead_id = p_lead_id and t.id = p_task_id
  returning t.* into v_closed;

  if v_closed.id is null then
    return;
  end if;

  if p_outcome = 'completed' and v_closed.repeat_rule <> 'none' then
    select * into v_next from public.lead_task_next_due(
      v_closed.series_anchor_at, v_closed.repeat_rule, v_closed.occurrence_index + 1,
      public.lead_task_tenant_timezone(p_tenant_id)
    );
    -- due_date / start_date are filled by the sync trigger.
    insert into public.lead_tasks (
      tenant_id, lead_id, title, description, due_at, repeat_rule, series_id, series_anchor_at,
      occurrence_index, created_by
    ) values (
      v_closed.tenant_id, v_closed.lead_id, v_closed.title, v_closed.description, v_next.next_due,
      v_closed.repeat_rule, v_closed.series_id, v_closed.series_anchor_at, v_next.next_index,
      v_closed.created_by
    );
  end if;

  return next v_closed;
end;
$$;

revoke all on function public.close_lead_task(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.close_lead_task(uuid, uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Whose task: assignee -> creator -> owner, active members only.
-- ---------------------------------------------------------------------------
create or replace function public.lead_task_owner(p_tenant_id uuid, p_assigned_user_id uuid, p_created_by uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select m.user_id from public.tenant_memberships as m
      where m.tenant_id = p_tenant_id and m.user_id = p_assigned_user_id and m.membership_status = 'active'),
    (select m.user_id from public.tenant_memberships as m
      where m.tenant_id = p_tenant_id and m.user_id = p_created_by and m.membership_status = 'active'),
    (select m.user_id from public.tenant_memberships as m
      where m.tenant_id = p_tenant_id and m.membership_role = 'owner' and m.membership_status = 'active'
      order by m.created_at limit 1)
  );
$$;

revoke all on function public.lead_task_owner(uuid, uuid, uuid) from public, anon, authenticated;

-- Tasks page rows. Bucket boundaries are computed here on the company clock:
--   overdue  open, due before now
--   today    open, due from now to the end of today
--   upcoming open, due from tomorrow
--   done     completed, closed within [p_from, p_to)
-- p_owner_user_id null = everyone (company owner view).
create or replace function public.list_tracked_tasks(
  p_tenant_id uuid, p_bucket text, p_owner_user_id uuid,
  p_from timestamptz default null, p_to timestamptz default null,
  p_limit integer default 50, p_offset integer default 0
)
returns table (
  id uuid, lead_id uuid, title text, due_at timestamptz, original_due_at timestamptz, repeat_rule text,
  status text, closed_at timestamptz, lead_name text, lead_phone text, owner_user_id uuid, owner_name text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text := public.lead_task_tenant_timezone(p_tenant_id);
  v_tomorrow timestamptz := (date_trunc('day', now() at time zone v_tz) + interval '1 day') at time zone v_tz;
begin
  if p_bucket not in ('overdue', 'today', 'upcoming', 'done') then
    raise exception 'Unknown bucket' using errcode = '22023';
  end if;
  return query
    select t.id, t.lead_id, t.title, t.due_at, t.original_due_at, t.repeat_rule, t.status, t.closed_at,
           l.lead_name, l.lead_phone, o.owner_id, p.full_name
    from public.lead_tasks as t
    join public.lead_data as l on l.tenant_id = t.tenant_id and l.id = t.lead_id
    cross join lateral (select public.lead_task_owner(t.tenant_id, l.assigned_user_id, t.created_by) as owner_id) as o
    left join public.profiles as p on p.user_id = o.owner_id
    where t.tenant_id = p_tenant_id
      and (p_owner_user_id is null or o.owner_id = p_owner_user_id)
      and case p_bucket
        when 'overdue' then t.status = 'open' and t.due_at < now()
        when 'today' then t.status = 'open' and t.due_at >= now() and t.due_at < v_tomorrow
        when 'upcoming' then t.status = 'open' and t.due_at >= v_tomorrow
        else t.status = 'completed' and (p_from is null or t.closed_at >= p_from) and (p_to is null or t.closed_at < p_to)
      end
    order by
      case when p_bucket = 'done' then null else t.due_at end asc,
      case when p_bucket = 'done' then t.closed_at end desc,
      t.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Per-tab counts plus the Done tab's on-time figure (against the ORIGINAL due time).
create or replace function public.count_tracked_tasks(
  p_tenant_id uuid, p_owner_user_id uuid, p_from timestamptz default null, p_to timestamptz default null
)
returns table (overdue bigint, today bigint, upcoming bigint, done bigint, done_on_time bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text := public.lead_task_tenant_timezone(p_tenant_id);
  v_tomorrow timestamptz := (date_trunc('day', now() at time zone v_tz) + interval '1 day') at time zone v_tz;
begin
  return query
    select
      count(*) filter (where t.status = 'open' and t.due_at < now()),
      count(*) filter (where t.status = 'open' and t.due_at >= now() and t.due_at < v_tomorrow),
      count(*) filter (where t.status = 'open' and t.due_at >= v_tomorrow),
      count(*) filter (where t.status = 'completed' and (p_from is null or t.closed_at >= p_from) and (p_to is null or t.closed_at < p_to)),
      count(*) filter (where t.status = 'completed' and (p_from is null or t.closed_at >= p_from) and (p_to is null or t.closed_at < p_to)
                        and t.closed_at <= t.original_due_at)
    from public.lead_tasks as t
    join public.lead_data as l on l.tenant_id = t.tenant_id and l.id = t.lead_id
    where t.tenant_id = p_tenant_id
      and t.status <> 'cancelled'
      and (p_owner_user_id is null or public.lead_task_owner(t.tenant_id, l.assigned_user_id, t.created_by) = p_owner_user_id);
end;
$$;

revoke all on function public.list_tracked_tasks(uuid, text, uuid, timestamptz, timestamptz, integer, integer) from public, anon, authenticated;
revoke all on function public.count_tracked_tasks(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.list_tracked_tasks(uuid, text, uuid, timestamptz, timestamptz, integer, integer) to service_role;
grant execute on function public.count_tracked_tasks(uuid, uuid, timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Reminders
-- ---------------------------------------------------------------------------
create table public.task_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  user_id uuid not null,
  task_id uuid not null references public.lead_tasks(id) on delete cascade,
  lead_id uuid not null,
  kind text not null check (kind in ('due_soon', 'due_now')),
  due_at timestamptz not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  -- A rescheduled task gets fresh reminders for its new due time; the same due time never alerts twice.
  constraint task_notifications_once unique (task_id, kind, due_at)
);

create index task_notifications_user_idx on public.task_notifications (tenant_id, user_id, created_at desc);

alter table public.task_notifications enable row level security;
alter table public.task_notifications force row level security;
revoke all on table public.task_notifications from public, anon, authenticated;
grant select, insert, update (read_at) on table public.task_notifications to service_role;

-- Deploy safety: tasks already due (or due within 15 minutes) are marked as alerted, so the first run
-- does not flood everyone with old reminders. Read immediately.
insert into public.task_notifications (tenant_id, user_id, task_id, lead_id, kind, due_at, read_at)
select t.tenant_id, o.owner_id, t.id, t.lead_id, k.kind, t.due_at, now()
from public.lead_tasks as t
join public.lead_data as l on l.tenant_id = t.tenant_id and l.id = t.lead_id
cross join lateral (select public.lead_task_owner(t.tenant_id, l.assigned_user_id, t.created_by) as owner_id) as o
cross join (values ('due_soon'), ('due_now')) as k(kind)
where t.status = 'open' and t.due_at <= now() + interval '15 minutes' and o.owner_id is not null
on conflict do nothing;

-- Called every minute. Creates the reminders that are due, broadcasts a PII-free signal per reminder on
-- the company's private live channel, and returns the new rows (the worker sends Web Push for them).
-- p_tenant_id limits a run to one company (tests).
create or replace function public.enqueue_task_reminders(p_tenant_id uuid default null)
returns setof public.task_notifications
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.task_notifications;
begin
  for v_row in
    insert into public.task_notifications (tenant_id, user_id, task_id, lead_id, kind, due_at)
    select t.tenant_id, o.owner_id, t.id, t.lead_id, k.kind, t.due_at
    from public.lead_tasks as t
    join public.lead_data as l on l.tenant_id = t.tenant_id and l.id = t.lead_id
    cross join lateral (select public.lead_task_owner(t.tenant_id, l.assigned_user_id, t.created_by) as owner_id) as o
    cross join (values ('due_soon'), ('due_now')) as k(kind)
    where t.status = 'open'
      and (p_tenant_id is null or t.tenant_id = p_tenant_id)
      and o.owner_id is not null
      and case k.kind
        when 'due_soon' then t.due_at - interval '15 minutes' <= now() and now() < t.due_at
        else t.due_at <= now() and t.due_at > now() - interval '1 hour'
      end
    on conflict do nothing
    returning *
  loop
    perform realtime.send(
      pg_catalog.jsonb_build_object('notification_id', v_row.id, 'user_id', v_row.user_id),
      'task_reminder', 'dashboard:' || v_row.tenant_id::text, true
    );
    return next v_row;
  end loop;
end;
$$;

revoke all on function public.enqueue_task_reminders(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_task_reminders(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Browser push subscriptions
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  user_id uuid not null,
  endpoint text not null unique check (endpoint like 'https://%' and length(endpoint) <= 2000),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  created_at timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (tenant_id, user_id);

alter table public.push_subscriptions enable row level security;
alter table public.push_subscriptions force row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions to service_role;

notify pgrst, 'reload schema';
