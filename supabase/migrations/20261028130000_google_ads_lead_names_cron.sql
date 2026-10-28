-- Every-minute Google Ads name worker, on Supabase Cron like the other worker timers
-- (20261021120000_worker_cron_jobs.sql). Apply ONLY after /api/queues/google/lead-names is live on main:
-- before that the job would call a route that does not exist yet.
--
-- Undo: select cron.unschedule('crm-google-lead-names');

-- cron.schedule upserts by job name, so re-running this never duplicates the job.
select cron.schedule('crm-google-lead-names', '* * * * *',
  $$ select private.invoke_scheduled_worker('/api/queues/google/lead-names') $$);
