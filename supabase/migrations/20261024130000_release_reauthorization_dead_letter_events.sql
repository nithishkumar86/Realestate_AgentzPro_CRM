-- Leads whose retrieval stopped (dead_letter) only because the Page's Facebook authorization had failed
-- (last_error_code 'META_REAUTHORIZATION_REQUIRED', written by schedule_meta_lead_retrieval_retry) were
-- never retried: release_pending_reconnect_meta_events only releases 'pending_reconnect' events, so the
-- lead that first hit the dead token stayed missing even after the tenant reconnected the Page.
--
-- Additive only. No existing function, trigger, constraint or status is changed. The application calls
-- this right after release_pending_reconnect_meta_events when a Page is reconnected.

-- Partial index: only reconnect-caused dead letters, looked up per tenant and Page like the
-- pending_reconnect index.
create index meta_webhook_events_reauthorization_dead_letter_idx
    on public.meta_webhook_notification_events (tenant_id, facebook_page_id)
    where processing_status = 'dead_letter' and last_error_code = 'META_REAUTHORIZATION_REQUIRED';

-- Same scoping as release_pending_reconnect_meta_events: one tenant, the reconnected Pages, and only
-- while that tenant's Page row is active again.
--
-- retrieval_attempt_count is reset because claim_meta_webhook_notification_event only claims events with
-- fewer than 6 attempts: an event that used up its attempts before or on the authorization failure would
-- otherwise be released to 'pending' and never claimed. Those attempts failed against the old, dead
-- authorization, and every release needs a fresh reconnect by the tenant, so this cannot loop.
create function public.release_reauthorization_dead_letter_meta_events(p_tenant_id uuid, p_facebook_page_ids text[])
returns table (id uuid, tenant_id uuid, dispatch_generation uuid)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with released as (
    update public.meta_webhook_notification_events as event
    set processing_status = 'pending', retrieval_attempt_count = 0,
        claim_token = null, processing_started_at = null, next_retrieval_attempt_at = null,
        queue_dispatched_at = null, dispatch_generation = gen_random_uuid()
    from public.facebook_pages as page
    where event.processing_status = 'dead_letter'
      and event.last_error_code = 'META_REAUTHORIZATION_REQUIRED'
      and event.tenant_id = p_tenant_id
      and event.facebook_page_id = any(p_facebook_page_ids)
      and page.id = event.facebook_page_record_id and page.tenant_id = event.tenant_id
      and page.connection_status = 'active' and page.token_status = 'active'
    returning event.id, event.tenant_id, event.dispatch_generation
  )
  select released.id, released.tenant_id, released.dispatch_generation from released;
end;
$$;

revoke all on function public.release_reauthorization_dead_letter_meta_events(uuid, text[]) from public, anon, authenticated;
grant execute on function public.release_reauthorization_dead_letter_meta_events(uuid, text[]) to service_role;
