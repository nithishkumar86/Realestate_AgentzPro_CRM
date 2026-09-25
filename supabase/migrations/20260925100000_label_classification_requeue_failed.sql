-- Re-queues AI label classifications that ended as 'failed', so a gateway or
-- model outage longer than one retry cycle (about 40 minutes) no longer leaves
-- the leads that arrived during it stuck at the default label for good.
--
-- A failed row is re-queued after a 30 minute cool-off with a fresh retry
-- budget (retry_count reset, so schedule_label_classification_retry allows
-- the full 6 attempts again). requeue_count caps this at 48 cycles, roughly
-- two days of coverage, after which the row stays 'failed' permanently.
-- Telecaller-owned rows are never 'failed' (Trigger C closes them out as
-- 'completed'), and the label_source filter below guards that explicitly.
--
-- recover_label_classifications keeps its exact signature and grants, and is
-- already called at the start of every worker sweep, so no application code
-- changes are needed for this to take effect.
begin;

alter table public.lead_label_classifications
  add column if not exists requeue_count integer not null default 0 check (requeue_count >= 0);

create index if not exists lead_label_classifications_failed_idx
  on public.lead_label_classifications (updated_at)
  where status = 'failed';

create or replace function public.recover_label_classifications()
returns integer language plpgsql security definer set search_path = '' as $$
declare recovered integer; requeued integer;
begin
  update public.lead_label_classifications set status = 'retry_scheduled', claim_token = null,
    lease_expires_at = null, next_retry_at = clock_timestamp(),
    last_error_code = 'WORKER_LEASE_EXPIRED', last_error_message = 'The label classification worker lease expired before completion.'
  where claim_token is not null and lease_expires_at <= clock_timestamp();
  get diagnostics recovered = row_count;

  -- last_error_code/message are kept so the original failure stays visible.
  update public.lead_label_classifications set status = 'retry_scheduled', retry_count = 0,
    requeue_count = requeue_count + 1, next_retry_at = clock_timestamp()
  where status = 'failed'
    and label_source <> 'telecaller'
    and requeue_count < 48
    and updated_at <= clock_timestamp() - interval '30 minutes';
  get diagnostics requeued = row_count;

  return recovered + requeued;
end;
$$;

commit;
