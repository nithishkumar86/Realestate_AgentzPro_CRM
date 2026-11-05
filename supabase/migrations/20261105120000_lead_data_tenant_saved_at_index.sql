-- /leads "new leads arrived" bar: an index for each company's newest-saved lead.
--
-- getLeadsCursor (src/lib/server/lead-query-service.ts) runs on every /leads table load:
--   select created_at from lead_data where tenant_id = $1 order by created_at desc limit 1
-- Every existing lead_data date index is on lead_created_time (when the person filled the form), none on created_at
-- (when the row was saved), so Postgres reads all of the company's leads to find the newest one. With this index it
-- reads one entry.
--
-- Only this index is added. No table, column, data, constraint, function, trigger, grant or policy changes. The Meta,
-- Google Ads and call-in save functions are untouched; on each new lead Postgres also adds one entry here, the same as
-- for the other lead_data indexes. It is not unique, so it can never reject a lead.
--
-- Locks: create index blocks lead writes while it builds (27 rows, 608 kB on prod at 2026-11-05, so milliseconds).
-- A lead saved in that moment waits, then saves; it is never rejected. lock_timeout makes the build fail and roll
-- back cleanly, changing nothing, instead of queueing every lead write behind a long query.
-- Undo: supabase/rollbacks/20261105120000_lead_data_tenant_saved_at_index.rollback.sql.

begin;
set local lock_timeout = '5s';

create index lead_data_tenant_saved_at_idx
  on public.lead_data (tenant_id, created_at desc);

commit;
