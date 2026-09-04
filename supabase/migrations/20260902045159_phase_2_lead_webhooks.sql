create table public.meta_webhook_notification_events (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
    facebook_page_record_id uuid not null references public.facebook_pages(id) on delete restrict,
    facebook_page_id text not null,
    meta_entry_id text not null,
    meta_entry_time timestamptz not null,
    leadgen_id text not null,
    form_id text not null,
    adgroup_id text,
    ad_id text,
    lead_created_time timestamptz not null,
    raw_webhook_change jsonb not null check (jsonb_typeof(raw_webhook_change) = 'object'),
    processing_status text not null default 'pending' check (processing_status in ('pending', 'processing', 'retry_scheduled', 'completed', 'dead_letter')),
    retrieval_attempt_count integer not null default 0 check (retrieval_attempt_count >= 0),
    queue_dispatched_at timestamptz,
    processing_started_at timestamptz,
    last_retrieval_attempt_at timestamptz,
    next_retrieval_attempt_at timestamptz,
    completed_at timestamptz,
    last_error_code text,
    last_error_message text,
    received_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint meta_webhook_notification_events_leadgen_id_key unique (leadgen_id),
    constraint meta_webhook_events_lead_relationship_unique unique (id, tenant_id, facebook_page_record_id, facebook_page_id, leadgen_id),
    constraint meta_webhook_notification_events_completed_check check (
        (processing_status = 'completed' and completed_at is not null)
        or (processing_status <> 'completed' and completed_at is null)
    )
);

create table public.lead_data (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
    webhook_notification_event_id uuid not null,
    leadgen_id text not null,
    facebook_page_record_id uuid not null,
    facebook_page_id text not null,
    form_id text not null,
    ad_id text,
    lead_created_time timestamptz not null,
    field_data jsonb not null check (jsonb_typeof(field_data) = 'array'),
    custom_disclaimer_responses jsonb check (custom_disclaimer_responses is null or jsonb_typeof(custom_disclaimer_responses) = 'array'),
    raw_lead_payload jsonb not null check (jsonb_typeof(raw_lead_payload) = 'object'),
    retrieved_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint lead_data_notification_event_fk foreign key (
        webhook_notification_event_id, tenant_id, facebook_page_record_id, facebook_page_id, leadgen_id
    ) references public.meta_webhook_notification_events (
        id, tenant_id, facebook_page_record_id, facebook_page_id, leadgen_id
    ) on delete restrict,
    constraint lead_data_notification_event_key unique (webhook_notification_event_id),
    constraint lead_data_leadgen_id_key unique (leadgen_id)
);

create index meta_webhook_events_tenant_id_idx on public.meta_webhook_notification_events (tenant_id);
create index meta_webhook_events_page_record_id_idx on public.meta_webhook_notification_events (facebook_page_record_id);
create index meta_webhook_events_facebook_page_id_idx on public.meta_webhook_notification_events (facebook_page_id);
create index meta_webhook_events_dispatch_recovery_idx on public.meta_webhook_notification_events (received_at)
    where processing_status = 'pending' and queue_dispatched_at is null;
create index meta_webhook_events_retry_idx on public.meta_webhook_notification_events (next_retrieval_attempt_at)
    where processing_status = 'retry_scheduled';
create index meta_webhook_events_processing_recovery_idx on public.meta_webhook_notification_events (processing_started_at)
    where processing_status = 'processing';
create index lead_data_tenant_id_idx on public.lead_data (tenant_id);
create index lead_data_page_record_id_idx on public.lead_data (facebook_page_record_id);
create index lead_data_facebook_page_id_idx on public.lead_data (facebook_page_id);
create index lead_data_form_id_idx on public.lead_data (form_id);
create index lead_data_ad_id_idx on public.lead_data (ad_id) where ad_id is not null;
create index lead_data_tenant_created_time_idx on public.lead_data (tenant_id, lead_created_time desc);

create or replace function public.validate_webhook_event_page_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    resolved_tenant_id uuid;
    resolved_facebook_page_id text;
    resolved_connected_at timestamptz;
begin
    select fp.tenant_id, fp.facebook_page_id, fp.connected_at
    into resolved_tenant_id, resolved_facebook_page_id, resolved_connected_at
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
    if resolved_connected_at > new.lead_created_time then
        raise exception 'Lead predates the resolved Facebook Page connection';
    end if;
    return new;
end;
$$;

create trigger validate_webhook_event_page_connection
before insert or update of tenant_id, facebook_page_record_id, facebook_page_id, lead_created_time
on public.meta_webhook_notification_events
for each row execute function public.validate_webhook_event_page_connection();

create trigger set_meta_webhook_events_updated_at
before update on public.meta_webhook_notification_events
for each row execute function public.set_updated_at();

create trigger set_lead_data_updated_at
before update on public.lead_data
for each row execute function public.set_updated_at();

create or replace function public.claim_meta_webhook_notification_event(p_event_id uuid)
returns public.meta_webhook_notification_events
language plpgsql
security definer
set search_path = ''
as $$
declare
    claimed_event public.meta_webhook_notification_events;
begin
    update public.meta_webhook_notification_events
    set processing_status = 'processing',
        processing_started_at = now(),
        last_retrieval_attempt_at = now(),
        retrieval_attempt_count = retrieval_attempt_count + 1
    where id = p_event_id
      and retrieval_attempt_count < 6
      and (
        processing_status = 'pending'
        or (processing_status = 'retry_scheduled' and next_retrieval_attempt_at <= now())
      )
    returning * into claimed_event;

    return claimed_event;
end;
$$;

create or replace function public.complete_meta_lead_retrieval_event(
    p_event_id uuid,
    p_field_data jsonb,
    p_custom_disclaimer_responses jsonb,
    p_raw_lead_payload jsonb,
    p_retrieved_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    event_row public.meta_webhook_notification_events;
begin
    select * into event_row
    from public.meta_webhook_notification_events
    where id = p_event_id
    for update;

    if event_row.id is null then
        raise exception 'Webhook notification event not found';
    end if;
    if event_row.processing_status <> 'processing' then
        raise exception 'Webhook notification event is not claimed';
    end if;

    insert into public.lead_data (
        tenant_id, webhook_notification_event_id, leadgen_id, facebook_page_record_id, facebook_page_id,
        form_id, ad_id, lead_created_time, field_data, custom_disclaimer_responses, raw_lead_payload, retrieved_at
    ) values (
        event_row.tenant_id, event_row.id, event_row.leadgen_id, event_row.facebook_page_record_id, event_row.facebook_page_id,
        event_row.form_id, event_row.ad_id, event_row.lead_created_time, p_field_data, p_custom_disclaimer_responses,
        p_raw_lead_payload, p_retrieved_at
    ) on conflict (leadgen_id) do nothing;

    update public.meta_webhook_notification_events
    set processing_status = 'completed',
        completed_at = now(),
        processing_started_at = null,
        next_retrieval_attempt_at = null,
        last_error_code = null,
        last_error_message = null
    where id = event_row.id;
end;
$$;

create or replace function public.schedule_meta_lead_retrieval_retry(
    p_event_id uuid,
    p_next_retrieval_attempt_at timestamptz,
    p_error_code text,
    p_error_message text,
    p_requires_reauthorization boolean default false,
    p_force_dead_letter boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    event_row public.meta_webhook_notification_events;
begin
    select * into event_row
    from public.meta_webhook_notification_events
    where id = p_event_id
    for update;

    if event_row.id is null or event_row.processing_status <> 'processing' then
        return;
    end if;

    if p_requires_reauthorization then
        update public.facebook_pages
        set connection_status = 'reauthorization_required', token_status = 'reauthorization_required'
        where id = event_row.facebook_page_record_id and tenant_id = event_row.tenant_id;
    end if;

    update public.meta_webhook_notification_events
    set processing_status = case when p_requires_reauthorization or p_force_dead_letter or retrieval_attempt_count >= 6 then 'dead_letter' else 'retry_scheduled' end,
        processing_started_at = null,
        queue_dispatched_at = case when p_requires_reauthorization or p_force_dead_letter or retrieval_attempt_count >= 6 then queue_dispatched_at else null end,
        next_retrieval_attempt_at = case when p_requires_reauthorization or p_force_dead_letter or retrieval_attempt_count >= 6 then null else p_next_retrieval_attempt_at end,
        last_error_code = left(p_error_code, 120),
        last_error_message = left(p_error_message, 500)
    where id = event_row.id;
end;
$$;

create or replace function public.mark_meta_webhook_event_dispatched(p_event_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
    update public.meta_webhook_notification_events
    set queue_dispatched_at = now()
    where id = p_event_id
      and processing_status in ('pending', 'retry_scheduled');
$$;

create or replace function public.recover_meta_webhook_notification_events()
returns table (id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.meta_webhook_notification_events
    set processing_status = 'retry_scheduled',
        processing_started_at = null,
        queue_dispatched_at = null,
        next_retrieval_attempt_at = now(),
        last_error_code = 'WORKER_LEASE_EXPIRED',
        last_error_message = 'The retrieval worker lease expired before completion.'
    where processing_status = 'processing'
      and processing_started_at < now() - interval '10 minutes';

    return query
    select event.id
    from public.meta_webhook_notification_events as event
    where (processing_status = 'pending' and queue_dispatched_at is null)
       or (processing_status = 'retry_scheduled' and queue_dispatched_at is null and next_retrieval_attempt_at <= now())
    order by received_at
    limit 100;
end;
$$;

alter table public.meta_webhook_notification_events enable row level security;
alter table public.meta_webhook_notification_events force row level security;
alter table public.lead_data enable row level security;
alter table public.lead_data force row level security;

revoke all on table public.meta_webhook_notification_events from public, anon, authenticated;
revoke all on table public.lead_data from public, anon, authenticated;
grant select, insert, update on table public.meta_webhook_notification_events to service_role;
grant select, insert, update on table public.lead_data to service_role;

revoke all on function public.validate_webhook_event_page_connection() from public, anon, authenticated;
revoke all on function public.claim_meta_webhook_notification_event(uuid) from public, anon, authenticated;
revoke all on function public.complete_meta_lead_retrieval_event(uuid, jsonb, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.schedule_meta_lead_retrieval_retry(uuid, timestamptz, text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.mark_meta_webhook_event_dispatched(uuid) from public, anon, authenticated;
revoke all on function public.recover_meta_webhook_notification_events() from public, anon, authenticated;
grant execute on function public.claim_meta_webhook_notification_event(uuid) to service_role;
grant execute on function public.complete_meta_lead_retrieval_event(uuid, jsonb, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.schedule_meta_lead_retrieval_retry(uuid, timestamptz, text, text, boolean, boolean) to service_role;
grant execute on function public.mark_meta_webhook_event_dispatched(uuid) to service_role;
grant execute on function public.recover_meta_webhook_notification_events() to service_role;
