-- Leads that arrive while their Page needs reconnection are held as 'pending_reconnect' instead of being
-- dropped, then released into the normal retrieval pipeline once the Page is active again.
-- Deploy together with the lead-webhook-service, lead-recovery-service and connection-service changes.
--
-- Duplicates: meta_webhook_notification_events and lead_data already enforce unique (leadgen_id), which is
-- stricter than unique (leadgen_id, tenant_id), so a lead re-delivered after backfill cannot be stored twice.
begin;

alter table public.meta_webhook_notification_events drop constraint meta_webhook_notification_events_processing_status_check;
alter table public.meta_webhook_notification_events add constraint meta_webhook_notification_events_processing_status_check
    check (processing_status in ('pending', 'pending_reconnect', 'processing', 'retry_scheduled', 'completed', 'dead_letter'));

create index meta_webhook_events_pending_reconnect_idx on public.meta_webhook_notification_events (tenant_id, facebook_page_id)
    where processing_status = 'pending_reconnect';

-- Called right after a tenant reconnects Pages. Only releases leads whose Page row is active again.
create function public.release_pending_reconnect_meta_events(p_tenant_id uuid, p_facebook_page_ids text[])
returns table (id uuid, dispatch_generation uuid)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with released as (
    update public.meta_webhook_notification_events as event
    set processing_status = 'pending', queue_dispatched_at = null, dispatch_generation = gen_random_uuid()
    from public.facebook_pages as page
    where event.processing_status = 'pending_reconnect'
      and event.tenant_id = p_tenant_id
      and event.facebook_page_id = any(p_facebook_page_ids)
      and page.id = event.facebook_page_record_id and page.tenant_id = event.tenant_id
      and page.connection_status = 'active' and page.token_status = 'active'
    returning event.id, event.dispatch_generation
  )
  select released.id, released.dispatch_generation from released;
end;
$$;

-- Same body as 20260908131754, plus a sweep that releases held leads for Pages that are active again.
-- This covers a failed release call after reconnect and a lead held in the moment the Page reconnected.
create or replace function public.recover_meta_webhook_notification_events()
returns table (id uuid, dispatch_generation uuid)
language plpgsql security definer set search_path = '' as $$
begin
  update public.meta_webhook_notification_events as event
  set processing_status = 'pending', queue_dispatched_at = null, dispatch_generation = gen_random_uuid()
  from public.facebook_pages as page
  where event.processing_status = 'pending_reconnect'
    and page.id = event.facebook_page_record_id and page.tenant_id = event.tenant_id
    and page.connection_status = 'active' and page.token_status = 'active';

  update public.meta_webhook_notification_events as event
  set processing_status = case when event.retrieval_attempt_count >= 6 then 'dead_letter' else 'retry_scheduled' end,
    claim_token = null, processing_started_at = null, queue_dispatched_at = null,
    dispatch_generation = gen_random_uuid(),
    next_retrieval_attempt_at = case when event.retrieval_attempt_count >= 6 then null else clock_timestamp() end,
    last_error_code = 'WORKER_LEASE_EXPIRED', last_error_message = 'The retrieval worker lease expired before completion.'
  where event.processing_status = 'processing'
    and event.processing_started_at <= clock_timestamp() - interval '10 minutes';
  return query select event.id, event.dispatch_generation
  from public.meta_webhook_notification_events as event
  where (event.processing_status = 'pending' and event.queue_dispatched_at is null)
    or (event.processing_status = 'retry_scheduled' and event.queue_dispatched_at is null
      and event.next_retrieval_attempt_at <= clock_timestamp())
  order by event.received_at limit 100;
end;
$$;

revoke all on function public.release_pending_reconnect_meta_events(uuid, text[]) from public, anon, authenticated;
grant execute on function public.release_pending_reconnect_meta_events(uuid, text[]) to service_role;

commit;
