-- The leads UI now lets a user permanently delete a lead (checkbox + confirm popup, then
-- DELETE /api/leads/[id]). That route runs as service_role, which the original
-- phase_2_lead_webhooks migration only granted select/insert/update on lead_data — so the
-- delete would otherwise fail with "permission denied for table lead_data" even though the
-- query itself is correctly tenant-scoped.
begin;

grant delete on table public.lead_data to service_role;

commit;
