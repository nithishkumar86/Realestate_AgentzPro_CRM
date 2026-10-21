-- "Clear all" in the bell: a cleared alert leaves the member's list but its row stays, so the
-- task_notifications_once key still stops the same reminder from being created again.
-- Additive: older code never reads the column.
alter table public.task_notifications add column if not exists cleared_at timestamptz;

grant update (cleared_at) on table public.task_notifications to service_role;
