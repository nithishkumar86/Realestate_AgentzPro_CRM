-- Every-minute worker timers on Supabase Cron instead of QStash schedules.
--
-- QStash's free tier allows ~1,000 messages a day, and that same budget carries the live lead-retrieval
-- queue. Three every-minute schedules (~4,320 messages a day) would exhaust it and block real leads, so
-- the timers run here instead: pg_cron fires each minute and pg_net POSTs to the existing worker routes,
-- authenticated with the shared SUBSCRIPTION_CRON_SECRET in `x-cron-secret`. QStash keeps the
-- lead-retrieval queue and the two /api/cron schedules; nothing about those changes.
--
-- Each job is platform-wide: one run sweeps every tenant's due work, exactly as the QStash schedules were
-- designed, so the job count never grows with tenants.
--
-- No URL or secret lives in this file. Both are read from Vault at run time, so an environment that has
-- not been given them (local, preview) does nothing instead of calling production. To enable, run once
-- in the SQL Editor:
--   select vault.create_secret('https://<app host>', 'crm_worker_base_url');
--   select vault.create_secret('<SUBSCRIPTION_CRON_SECRET value>', 'crm_worker_cron_secret');

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pg_net with schema extensions;

-- Returns the pg_net request id, or null when this environment has no Vault entries. The response is
-- recorded in net._http_response (kept 6 hours by pg_net). The timeout is generous so a slow AI or Meta
-- run is recorded with its real status instead of a client-side timeout.
create or replace function private.invoke_scheduled_worker(p_path text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_base_url text;
  v_secret text;
begin
  select decrypted_secret into v_base_url from vault.decrypted_secrets where name = 'crm_worker_base_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'crm_worker_cron_secret';
  if v_base_url is null or v_secret is null then
    return null;
  end if;

  return net.http_post(
    url := rtrim(v_base_url, '/') || p_path,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 60000
  );
end;
$$;
revoke all on function private.invoke_scheduled_worker(text) from public, anon, authenticated;

-- cron.schedule upserts by job name, so re-running this migration never duplicates a job.
select cron.schedule('crm-lead-recovery', '* * * * *',
  $$ select private.invoke_scheduled_worker('/api/queues/meta/recovery') $$);
select cron.schedule('crm-label-classification', '* * * * *',
  $$ select private.invoke_scheduled_worker('/api/queues/ai/label-classification') $$);
select cron.schedule('crm-task-reminders', '* * * * *',
  $$ select private.invoke_scheduled_worker('/api/queues/tasks/reminders') $$);

-- pg_cron never prunes its run log (~4,300 rows a day from the jobs above). Keep 7 days, and only for
-- this app's jobs, since the database is shared with another project.
select cron.schedule('crm-cron-history-cleanup', '0 0 * * *',
  $$ delete from cron.job_run_details
     where end_time < now() - interval '7 days'
       and jobid in (select jobid from cron.job where jobname like 'crm-%') $$);
