-- Undo 20261105120000_lead_data_tenant_saved_at_index.sql.
--
-- No app change is needed first: the app never names this index. Without it the /leads newest-lead read goes back to
-- reading all of the company's leads, exactly as before. No data is touched.

begin;
set local lock_timeout = '5s';

drop index if exists public.lead_data_tenant_saved_at_idx;

commit;
