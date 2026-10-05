-- Narrow service_role on the Lead Timeline tables to exactly what 20261005120000 intended.
--
-- Supabase's default privileges grant ALL on every new public table to service_role, and that migration only
-- revoked from public/anon/authenticated, so service_role also had UPDATE, DELETE and TRUNCATE. UPDATE/DELETE
-- were still stopped by the append-only and task guard triggers, but TRUNCATE skips row triggers and could
-- have wiped the history. Revoke everything, then grant back only what the server uses:
--   lead_notes, lead_tasks: select, insert (task changes go through the security-definer RPCs)
--   lead_activities:        select (rows are written only by the security-definer trigger functions)
-- FK cascades from lead_data / tenants run as the table owner, so lead and tenant deletion keep working.

revoke all on table public.lead_notes, public.lead_tasks, public.lead_activities from service_role;
grant select, insert on table public.lead_notes to service_role;
grant select, insert on table public.lead_tasks to service_role;
grant select on table public.lead_activities to service_role;
