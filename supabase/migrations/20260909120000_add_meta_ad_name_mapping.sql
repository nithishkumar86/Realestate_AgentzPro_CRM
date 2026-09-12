-- Additive ad-name cache. Project cleanup is deliberately deferred until the
-- matching application release has passed the production acceptance checks.
begin;

create table public.meta_ads (
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  ad_id text not null check (length(btrim(ad_id)) > 0),
  source_facebook_page_record_id uuid,
  ad_name text,
  resolution_status text not null default 'pending'
    check (resolution_status in ('pending', 'resolved', 'transient_error', 'access_required', 'ad_unavailable', 'retry_exhausted')),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_retry_at timestamptz default clock_timestamp(),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, ad_id),
  foreign key (tenant_id, source_facebook_page_record_id)
    references public.facebook_pages(tenant_id, id) on delete restrict,
  constraint meta_ads_resolved_name_check check (
    resolution_status <> 'resolved'
    or (length(btrim(ad_name)) > 0 and last_resolved_at is not null)
  ),
  constraint meta_ads_claim_lease_check check (
    (claim_token is null) = (lease_expires_at is null)
  ),
  constraint meta_ads_terminal_schedule_check check (
    resolution_status not in ('resolved', 'access_required', 'ad_unavailable', 'retry_exhausted')
    or next_retry_at is null
  )
);

create trigger meta_ads_set_updated_at before update on public.meta_ads
  for each row execute function public.set_updated_at();

create index meta_ads_due_resolution_idx on public.meta_ads (next_retry_at, tenant_id, ad_id)
  where resolution_status in ('pending', 'transient_error');

alter table public.lead_data add column if not exists ad_name text;
create table public.meta_ad_name_migration_conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  lead_id uuid not null,
  ad_name text not null,
  ad_name_snapshot text not null,
  recorded_at timestamptz not null default now(),
  unique (lead_id)
);

create table public.project_records_archive (
  project_id uuid primary key,
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  project_name text not null,
  is_active boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz not null default now()
);

create table public.lead_project_assignments_archive (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  lead_id uuid not null,
  previous_project_id uuid,
  new_project_id uuid,
  changed_by_user_id uuid,
  reason text,
  changed_at timestamptz,
  archived_at timestamptz not null default now(),
  unique (tenant_id, lead_id, previous_project_id, new_project_id, changed_at)
);

insert into public.project_records_archive (project_id, tenant_id, project_name, is_active, created_at, updated_at)
select id, tenant_id, project_name, is_active, created_at, updated_at
from public.projects
on conflict (project_id) do nothing;

insert into public.lead_project_assignments_archive
  (tenant_id, lead_id, previous_project_id, new_project_id, changed_by_user_id, reason, changed_at)
select tenant_id, lead_id, previous_project_id, new_project_id, changed_by_user_id, reason, changed_at
from public.lead_project_assignment_audit
on conflict do nothing;

insert into public.meta_ad_name_migration_conflicts (tenant_id, lead_id, ad_name, ad_name_snapshot)
select tenant_id, id, ad_name, ad_name_snapshot
from public.lead_data
where nullif(btrim(ad_name), '') is not null
  and nullif(btrim(ad_name_snapshot), '') is not null
  and btrim(ad_name) <> btrim(ad_name_snapshot)
on conflict (lead_id) do nothing;

update public.lead_data
set ad_name = nullif(btrim(ad_name_snapshot), '')
where nullif(btrim(ad_name), '') is null
  and nullif(btrim(ad_name_snapshot), '') is not null;

update public.lead_data
set ad_id = null
where ad_id is not null and (btrim(ad_id) = '' or btrim(ad_id) ~ '^0+$');

update public.meta_webhook_notification_events
set ad_id = null
where ad_id is not null and (btrim(ad_id) = '' or btrim(ad_id) ~ '^0+$');

insert into public.meta_ads (
  tenant_id, ad_id, source_facebook_page_record_id, ad_name,
  resolution_status, next_retry_at, last_resolved_at
)
select
  lead.tenant_id,
  lead.ad_id,
  (array_agg(lead.facebook_page_record_id order by lead.created_at))[1],
  min(nullif(btrim(lead.ad_name), '')) filter (where nullif(btrim(lead.ad_name), '') is not null),
  case when count(distinct nullif(btrim(lead.ad_name), '')) filter (where nullif(btrim(lead.ad_name), '') is not null) = 1
    then 'resolved' else 'pending' end,
  case when count(distinct nullif(btrim(lead.ad_name), '')) filter (where nullif(btrim(lead.ad_name), '') is not null) = 1
    then null else clock_timestamp() end,
  case when count(distinct nullif(btrim(lead.ad_name), '')) filter (where nullif(btrim(lead.ad_name), '') is not null) = 1
    then clock_timestamp() else null end
from public.lead_data as lead
where lead.ad_id is not null
group by lead.tenant_id, lead.ad_id
on conflict (tenant_id, ad_id) do nothing;

create index lead_data_tenant_ad_created_idx on public.lead_data (tenant_id, ad_id, lead_created_time desc, id desc)
  where ad_id is not null;

create or replace function public.populate_meta_lead_contact_fields()
returns trigger language plpgsql set search_path = '' as $$
begin
  select lead_name, lead_email, lead_phone, lead_phone_normalized
  into new.lead_name, new.lead_email, new.lead_phone, new.lead_phone_normalized
  from public.extract_meta_lead_contact_fields(new.field_data);
  if TG_OP = 'UPDATE' and old.ad_name is not null then
    new.ad_name := old.ad_name;
  end if;
  return new;
end;
$$;

drop trigger if exists populate_meta_lead_contact_fields on public.lead_data;
create trigger populate_meta_lead_contact_fields
  before insert or update of field_data, ad_name on public.lead_data
  for each row execute function public.populate_meta_lead_contact_fields();

drop function public.complete_meta_lead_retrieval_event(uuid, uuid, jsonb, jsonb, jsonb, timestamptz, text);
create function public.complete_meta_lead_retrieval_event(
  p_event_id uuid, p_claim_token uuid, p_field_data jsonb,
  p_custom_disclaimer_responses jsonb, p_raw_lead_payload jsonb,
  p_retrieved_at timestamptz, p_ad_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  event_row public.meta_webhook_notification_events;
  cache_row public.meta_ads;
  existing_lead public.lead_data;
  resolved_ad_id text := nullif(btrim(p_ad_id), '');
begin
  if resolved_ad_id ~ '^0+$' then resolved_ad_id := null; end if;
  select * into event_row from public.meta_webhook_notification_events where id = p_event_id for update;
  if event_row.id is null or event_row.processing_status <> 'processing'
    or p_claim_token is null or event_row.claim_token is distinct from p_claim_token
    or event_row.processing_started_at <= clock_timestamp() - interval '10 minutes' then
    return false;
  end if;
  if event_row.ad_id is not null and resolved_ad_id is not null and event_row.ad_id <> resolved_ad_id then
    raise exception 'Retrieved ad does not match webhook ad' using errcode = '22023';
  end if;
  resolved_ad_id := coalesce(nullif(btrim(event_row.ad_id), ''), resolved_ad_id);
  if resolved_ad_id ~ '^0+$' then resolved_ad_id := null; end if;

  if resolved_ad_id is not null then
    insert into public.meta_ads (tenant_id, ad_id, source_facebook_page_record_id)
    values (event_row.tenant_id, resolved_ad_id, event_row.facebook_page_record_id)
    on conflict (tenant_id, ad_id) do nothing;
    select * into cache_row from public.meta_ads
    where tenant_id = event_row.tenant_id and ad_id = resolved_ad_id for update;
  end if;

  select * into existing_lead from public.lead_data where leadgen_id = event_row.leadgen_id for update;
  if existing_lead.id is not null then
    if existing_lead.tenant_id <> event_row.tenant_id
      or existing_lead.facebook_page_id <> event_row.facebook_page_id
      or existing_lead.form_id <> event_row.form_id
      or existing_lead.ad_id is distinct from resolved_ad_id then
      raise exception 'Duplicate lead conflicts with stored tenant or source' using errcode = 'P0001';
    end if;
  else
    insert into public.lead_data (
      tenant_id, webhook_notification_event_id, leadgen_id, facebook_page_record_id,
      facebook_page_id, form_id, ad_id, ad_name, lead_created_time, field_data,
      custom_disclaimer_responses, raw_lead_payload, retrieved_at
    ) values (
      event_row.tenant_id, event_row.id, event_row.leadgen_id, event_row.facebook_page_record_id,
      event_row.facebook_page_id, event_row.form_id, resolved_ad_id, cache_row.ad_name,
      event_row.lead_created_time, p_field_data, p_custom_disclaimer_responses,
      p_raw_lead_payload, p_retrieved_at
    );
  end if;

  update public.meta_webhook_notification_events
  set processing_status = 'completed', completed_at = clock_timestamp(), claim_token = null,
    ad_id = resolved_ad_id, processing_started_at = null, next_retrieval_attempt_at = null,
    last_error_code = null, last_error_message = null
  where id = event_row.id;
  return true;
end;
$$;

create function public.claim_due_meta_ad_name_resolution()
returns public.meta_ads language plpgsql security definer set search_path = '' as $$
declare claimed_row public.meta_ads;
begin
  with candidate as (
    select tenant_id, ad_id from public.meta_ads
    where resolution_status in ('pending', 'transient_error')
      and next_retry_at <= clock_timestamp()
      and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
    order by next_retry_at, tenant_id, ad_id
    for update skip locked limit 1
  ) update public.meta_ads as mapping
  set claim_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '10 minutes',
    retry_count = mapping.retry_count + 1
  from candidate
  where mapping.tenant_id = candidate.tenant_id and mapping.ad_id = candidate.ad_id
  returning mapping.* into claimed_row;
  return claimed_row;
end;
$$;

create function public.complete_meta_ad_name_resolution(
  p_tenant_id uuid, p_ad_id text, p_claim_token uuid, p_ad_name text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare mapping public.meta_ads; resolved_name text := nullif(btrim(p_ad_name), '');
begin
  if resolved_name is null then raise exception 'Ad name is required' using errcode = '22023'; end if;
  select * into mapping from public.meta_ads where tenant_id = p_tenant_id and ad_id = p_ad_id for update;
  if mapping.tenant_id is null or mapping.claim_token is distinct from p_claim_token
    or mapping.lease_expires_at <= clock_timestamp() then return false; end if;
  update public.meta_ads set ad_name = resolved_name, resolution_status = 'resolved',
    claim_token = null, lease_expires_at = null, next_retry_at = null,
    last_error_code = null, last_error_message = null, last_resolved_at = clock_timestamp()
  where tenant_id = p_tenant_id and ad_id = p_ad_id;
  update public.lead_data set ad_name = resolved_name
  where tenant_id = p_tenant_id and ad_id = p_ad_id and ad_name is null;
  return true;
end;
$$;

create function public.schedule_meta_ad_name_resolution_retry(
  p_tenant_id uuid, p_ad_id text, p_claim_token uuid, p_status text,
  p_next_retry_at timestamptz, p_error_code text, p_error_message text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare mapping public.meta_ads; terminal_status text;
begin
  if p_status not in ('transient_error', 'access_required', 'ad_unavailable') then
    raise exception 'Invalid ad resolution outcome' using errcode = '22023';
  end if;
  select * into mapping from public.meta_ads where tenant_id = p_tenant_id and ad_id = p_ad_id for update;
  if mapping.tenant_id is null or mapping.claim_token is distinct from p_claim_token
    or mapping.lease_expires_at <= clock_timestamp() then return false; end if;
  terminal_status := case when p_status = 'transient_error' and mapping.retry_count >= 6 then 'retry_exhausted' else p_status end;
  if terminal_status = 'transient_error' and p_next_retry_at is null then
    raise exception 'Retry timestamp is required' using errcode = '22023';
  end if;
  update public.meta_ads set resolution_status = terminal_status, claim_token = null, lease_expires_at = null,
    next_retry_at = case when terminal_status = 'transient_error' then p_next_retry_at else null end,
    last_error_code = left(coalesce(p_error_code, 'META_AD_NAME_RESOLUTION_FAILED'), 120),
    last_error_message = left(coalesce(p_error_message, 'The advertisement name could not be resolved.'), 500)
  where tenant_id = p_tenant_id and ad_id = p_ad_id;
  return true;
end;
$$;

create function public.recover_meta_ad_name_resolutions()
returns integer language plpgsql security definer set search_path = '' as $$
declare recovered integer;
begin
  update public.meta_ads set resolution_status = 'transient_error', claim_token = null,
    lease_expires_at = null, next_retry_at = clock_timestamp(),
    last_error_code = 'WORKER_LEASE_EXPIRED', last_error_message = 'The ad-name resolver lease expired before completion.'
  where claim_token is not null and lease_expires_at <= clock_timestamp();
  get diagnostics recovered = row_count;
  update public.lead_data as lead set ad_name = mapping.ad_name
  from public.meta_ads as mapping
  where lead.tenant_id = mapping.tenant_id and lead.ad_id = mapping.ad_id
    and lead.ad_name is null and mapping.resolution_status = 'resolved'
    and mapping.ad_name is not null;
  return recovered;
end;
$$;

alter table public.meta_ads enable row level security;
alter table public.meta_ads force row level security;
alter table public.meta_ad_name_migration_conflicts enable row level security;
alter table public.meta_ad_name_migration_conflicts force row level security;
alter table public.project_records_archive enable row level security;
alter table public.project_records_archive force row level security;
alter table public.lead_project_assignments_archive enable row level security;
alter table public.lead_project_assignments_archive force row level security;
revoke all on public.meta_ads, public.meta_ad_name_migration_conflicts, public.project_records_archive, public.lead_project_assignments_archive from public, anon, authenticated;
grant select, insert, update on public.meta_ads, public.meta_ad_name_migration_conflicts, public.project_records_archive, public.lead_project_assignments_archive to service_role;
revoke all on function public.complete_meta_lead_retrieval_event(uuid, uuid, jsonb, jsonb, jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.claim_due_meta_ad_name_resolution() from public, anon, authenticated;
revoke all on function public.complete_meta_ad_name_resolution(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.schedule_meta_ad_name_resolution_retry(uuid, text, uuid, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.recover_meta_ad_name_resolutions() from public, anon, authenticated;
grant execute on function public.complete_meta_lead_retrieval_event(uuid, uuid, jsonb, jsonb, jsonb, timestamptz, text) to service_role;
grant execute on function public.claim_due_meta_ad_name_resolution() to service_role;
grant execute on function public.complete_meta_ad_name_resolution(uuid, text, uuid, text) to service_role;
grant execute on function public.schedule_meta_ad_name_resolution_retry(uuid, text, uuid, text, timestamptz, text, text) to service_role;
grant execute on function public.recover_meta_ad_name_resolutions() to service_role;

commit;
