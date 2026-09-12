-- Deploy with the matching worker/dispatcher code; old RPC signatures fail closed.
begin;
alter table public.facebook_pages add column connection_generation uuid not null default gen_random_uuid();
create function public.rotate_facebook_page_generation() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.connection_generation := gen_random_uuid();
  return new;
end;
$$;
create trigger rotate_facebook_page_generation
before update of page_access_token_encrypted, meta_connection_id, connected_at, connection_status, token_status
on public.facebook_pages for each row execute function public.rotate_facebook_page_generation();
revoke all on function public.rotate_facebook_page_generation() from public, anon, authenticated;

alter table public.meta_webhook_notification_events
  add column claim_token uuid,
  add column dispatch_generation uuid not null default gen_random_uuid();
-- Invalidate legacy workers and repair previously stranded attempts.
update public.meta_webhook_notification_events
set processing_status = case when retrieval_attempt_count >= 6 then 'dead_letter' else 'retry_scheduled' end,
    processing_started_at = null, queue_dispatched_at = null,
    next_retrieval_attempt_at = case when retrieval_attempt_count >= 6 then null else now() end,
    last_error_code = 'PROCESSING_PROTOCOL_UPGRADED'
where processing_status in ('processing', 'retry_scheduled');
alter table public.meta_webhook_notification_events add constraint meta_retry_timestamp_required
  check (processing_status <> 'retry_scheduled' or next_retrieval_attempt_at is not null);
alter table public.meta_webhook_notification_events add constraint meta_processing_claim_required
  check ((processing_status = 'processing') = (claim_token is not null));

create or replace function public.claim_meta_webhook_notification_event(p_event_id uuid)
returns public.meta_webhook_notification_events language plpgsql security definer set search_path = '' as $$
declare claimed_event public.meta_webhook_notification_events;
begin
  update public.meta_webhook_notification_events
  set processing_status = 'processing', claim_token = gen_random_uuid(),
      processing_started_at = clock_timestamp(), last_retrieval_attempt_at = clock_timestamp(),
      retrieval_attempt_count = retrieval_attempt_count + 1
  where id = p_event_id and retrieval_attempt_count < 6
    and (processing_status = 'pending' or
      (processing_status = 'retry_scheduled' and next_retrieval_attempt_at <= clock_timestamp()))
  returning * into claimed_event;
  return claimed_event;
end;
$$;

drop function public.complete_meta_lead_retrieval_event(uuid, jsonb, jsonb, jsonb, timestamptz);
create function public.complete_meta_lead_retrieval_event(
  p_event_id uuid, p_claim_token uuid, p_field_data jsonb, p_custom_disclaimer_responses jsonb,
  p_raw_lead_payload jsonb, p_retrieved_at timestamptz, p_ad_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare event_row public.meta_webhook_notification_events; resolved_project_id uuid;
begin
  select * into event_row from public.meta_webhook_notification_events where id = p_event_id for update;
  if event_row.id is null or event_row.processing_status <> 'processing'
    or p_claim_token is null or event_row.claim_token is distinct from p_claim_token
    or event_row.processing_started_at <= clock_timestamp() - interval '10 minutes' then return false; end if;
  if event_row.ad_id is not null and p_ad_id is not null and event_row.ad_id <> p_ad_id then
    raise exception 'Retrieved ad does not match webhook ad' using errcode = '22023';
  end if;
  event_row.ad_id := coalesce(event_row.ad_id, nullif(p_ad_id, ''));
  select project_id into resolved_project_id from public.meta_ad_project_mappings
    where tenant_id = event_row.tenant_id and ad_id = event_row.ad_id;
  insert into public.lead_data (tenant_id, webhook_notification_event_id, leadgen_id, facebook_page_record_id,
    facebook_page_id, form_id, ad_id, lead_created_time, field_data, custom_disclaimer_responses,
    raw_lead_payload, retrieved_at, project_id)
  values (event_row.tenant_id, event_row.id, event_row.leadgen_id, event_row.facebook_page_record_id,
    event_row.facebook_page_id, event_row.form_id, event_row.ad_id, event_row.lead_created_time,
    p_field_data, p_custom_disclaimer_responses, p_raw_lead_payload, p_retrieved_at, resolved_project_id)
  on conflict (leadgen_id) do nothing;
  update public.meta_webhook_notification_events
  set processing_status = 'completed', completed_at = clock_timestamp(), claim_token = null,
    ad_id = event_row.ad_id, processing_started_at = null, next_retrieval_attempt_at = null,
    last_error_code = null, last_error_message = null
  where id = event_row.id;
  return true;
end;
$$;

drop function public.schedule_meta_lead_retrieval_retry(uuid, timestamptz, text, text, boolean, boolean);
create function public.schedule_meta_lead_retrieval_retry(
  p_event_id uuid, p_claim_token uuid, p_next_retrieval_attempt_at timestamptz,
  p_error_code text, p_error_message text, p_connection_generation uuid,
  p_requires_reauthorization boolean default false, p_force_dead_letter boolean default false
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  event_row public.meta_webhook_notification_events;
  page_row public.facebook_pages;
  stale_connection boolean := false;
  terminal boolean;
begin
  select * into event_row from public.meta_webhook_notification_events where id = p_event_id for update;
  if event_row.id is null or event_row.processing_status <> 'processing'
    or p_claim_token is null or event_row.claim_token is distinct from p_claim_token
    or event_row.processing_started_at <= clock_timestamp() - interval '10 minutes' then return false; end if;
  if coalesce(p_requires_reauthorization, false) then
    select * into page_row from public.facebook_pages
      where id = event_row.facebook_page_record_id and tenant_id = event_row.tenant_id for update;
    stale_connection := p_connection_generation is not null
      and page_row.connection_generation is distinct from p_connection_generation
      and page_row.connection_status = 'active' and page_row.token_status = 'active';
    if page_row.connection_status = 'active' and page_row.token_status = 'active'
      and p_connection_generation is not null and page_row.connection_generation = p_connection_generation then
      update public.facebook_pages set connection_status = 'reauthorization_required', token_status = 'reauthorization_required'
      where id = page_row.id;
    end if;
  end if;
  terminal := event_row.retrieval_attempt_count >= 6
    or ((coalesce(p_requires_reauthorization, false) or coalesce(p_force_dead_letter, false)) and not stale_connection);
  if not terminal and p_next_retrieval_attempt_at is null then
    raise exception 'Retry timestamp is required' using errcode = '22023';
  end if;
  update public.meta_webhook_notification_events
  set processing_status = case when terminal then 'dead_letter' else 'retry_scheduled' end,
    claim_token = null, processing_started_at = null, queue_dispatched_at = null,
    dispatch_generation = gen_random_uuid(),
    next_retrieval_attempt_at = case when terminal then null else p_next_retrieval_attempt_at end,
    last_error_code = left(p_error_code, 120), last_error_message = left(p_error_message, 500)
  where id = event_row.id;
  return true;
end;
$$;

drop function public.mark_meta_webhook_event_dispatched(uuid);
create function public.mark_meta_webhook_event_dispatched(p_event_id uuid, p_dispatch_generation uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.meta_webhook_notification_events set queue_dispatched_at = clock_timestamp()
  where id = p_event_id and dispatch_generation = p_dispatch_generation
    and processing_status in ('pending', 'retry_scheduled') and queue_dispatched_at is null;
  return found;
end;
$$;

drop function public.recover_meta_webhook_notification_events();
create function public.recover_meta_webhook_notification_events()
returns table (id uuid, dispatch_generation uuid)
language plpgsql security definer set search_path = '' as $$
begin
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

revoke all on function public.complete_meta_lead_retrieval_event(uuid, uuid, jsonb, jsonb, jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.schedule_meta_lead_retrieval_retry(uuid, uuid, timestamptz, text, text, uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function public.mark_meta_webhook_event_dispatched(uuid, uuid) from public, anon, authenticated;
revoke all on function public.recover_meta_webhook_notification_events() from public, anon, authenticated;
grant execute on function public.complete_meta_lead_retrieval_event(uuid, uuid, jsonb, jsonb, jsonb, timestamptz, text) to service_role;
grant execute on function public.schedule_meta_lead_retrieval_retry(uuid, uuid, timestamptz, text, text, uuid, boolean, boolean) to service_role;
grant execute on function public.mark_meta_webhook_event_dispatched(uuid, uuid) to service_role;
grant execute on function public.recover_meta_webhook_notification_events() to service_role;
commit;
