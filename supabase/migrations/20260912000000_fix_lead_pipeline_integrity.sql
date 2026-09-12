-- Lead pipeline integrity fixes. Deploy together with the matching
-- lead-webhook-service, lead-recovery-service, qstash-service and route changes.
--
-- 1. Stops silent lead loss when a tenant reconnects a Page.
--    connect_selected_facebook_pages sets connected_at = now() on every reconnect, but the webhook
--    router and the validation trigger both used connected_at as the "leads from here onward" cutoff.
--    A lead created seconds before a reconnect therefore failed the cutoff and was dropped, while the
--    webhook still answered Meta with 200 so Meta never redelivered it. lead_eligible_since records
--    when this tenant first took ownership of the Page and is never moved by a reconnect, so the
--    anti-backfill guarantee is kept without discarding in-flight leads.
--
-- 2. Returns tenant_id from the dispatch RPCs so the queue can apply per-tenant flow control
--    instead of serialising every tenant behind one global key.
begin;

-- Backfill from connected_at before adding the default, so existing Pages keep their current cutoff.
-- Adding the column with a default would stamp now() on every row and drop every in-flight lead.
alter table public.facebook_pages add column lead_eligible_since timestamptz;
update public.facebook_pages set lead_eligible_since = connected_at where lead_eligible_since is null;
alter table public.facebook_pages alter column lead_eligible_since set not null;
alter table public.facebook_pages alter column lead_eligible_since set default now();

comment on column public.facebook_pages.lead_eligible_since is
    'Earliest lead_created_time this tenant may receive for this Page. Set once when the tenant first '
    'connects the Page and deliberately preserved across disconnect/reconnect: connect_selected_facebook_pages '
    'never writes this column, so reconnecting only refreshes connected_at. A Page claimed by a different '
    'tenant inserts a new row and therefore gets a fresh cutoff, so no tenant can reach another tenant''s leads.';

-- Same body as 20260902045159, with the cutoff moved from connected_at to lead_eligible_since.
create or replace function public.validate_webhook_event_page_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    resolved_tenant_id uuid;
    resolved_facebook_page_id text;
    resolved_lead_eligible_since timestamptz;
begin
    select fp.tenant_id, fp.facebook_page_id, fp.lead_eligible_since
    into resolved_tenant_id, resolved_facebook_page_id, resolved_lead_eligible_since
    from public.facebook_pages as fp
    where fp.id = new.facebook_page_record_id;

    if resolved_tenant_id is null then
        raise exception 'Facebook Page connection record not found';
    end if;
    if resolved_tenant_id <> new.tenant_id then
        raise exception 'Facebook Page connection and tenant do not match';
    end if;
    if resolved_facebook_page_id <> new.facebook_page_id then
        raise exception 'Facebook Page IDs do not match';
    end if;
    if resolved_lead_eligible_since > new.lead_created_time then
        raise exception 'Lead predates the resolved Facebook Page connection';
    end if;
    return new;
end;
$$;

-- Same bodies as 20260911130000, with tenant_id added to the result so the dispatcher can build a
-- per-tenant flow-control key. Return type changes require drop + create.
drop function public.release_pending_reconnect_meta_events(uuid, text[]);
create function public.release_pending_reconnect_meta_events(p_tenant_id uuid, p_facebook_page_ids text[])
returns table (id uuid, tenant_id uuid, dispatch_generation uuid)
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
    returning event.id, event.tenant_id, event.dispatch_generation
  )
  select released.id, released.tenant_id, released.dispatch_generation from released;
end;
$$;

drop function public.recover_meta_webhook_notification_events();
create function public.recover_meta_webhook_notification_events()
returns table (id uuid, tenant_id uuid, dispatch_generation uuid)
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

  return query select event.id, event.tenant_id, event.dispatch_generation
  from public.meta_webhook_notification_events as event
  where (event.processing_status = 'pending' and event.queue_dispatched_at is null)
    or (event.processing_status = 'retry_scheduled' and event.queue_dispatched_at is null
      and event.next_retrieval_attempt_at <= clock_timestamp())
  order by event.received_at limit 100;
end;
$$;

revoke all on function public.release_pending_reconnect_meta_events(uuid, text[]) from public, anon, authenticated;
revoke all on function public.recover_meta_webhook_notification_events() from public, anon, authenticated;
grant execute on function public.release_pending_reconnect_meta_events(uuid, text[]) to service_role;
grant execute on function public.recover_meta_webhook_notification_events() to service_role;

commit;
