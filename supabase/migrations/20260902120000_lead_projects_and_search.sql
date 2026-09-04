-- Forward-only compatibility migration for the leads and project-management UI.
create extension if not exists pg_trgm;

alter table public.tenants add column if not exists timezone text not null default 'UTC';
alter table public.facebook_pages add constraint facebook_pages_tenant_id_id_key unique (tenant_id, id);
alter table public.lead_data add constraint lead_data_tenant_id_id_key unique (tenant_id, id);

alter table public.lead_data
  add column if not exists lead_name text,
  add column if not exists lead_email text,
  add column if not exists lead_phone text,
  add column if not exists lead_phone_normalized text,
  add column if not exists project_id uuid,
  add column if not exists ad_name_snapshot text;

create or replace function public.validate_tenant_timezone()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Invalid IANA timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_tenant_timezone on public.tenants;
create trigger validate_tenant_timezone before insert or update of timezone on public.tenants
  for each row execute function public.validate_tenant_timezone();

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  project_name text not null check (length(btrim(project_name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, project_name), unique (tenant_id, id)
);
create trigger projects_set_updated_at before update on public.projects for each row execute function public.set_updated_at();

create table if not exists public.meta_ad_project_mappings (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  project_id uuid not null, facebook_page_record_id uuid not null, ad_id text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, ad_id), unique (tenant_id, id),
  foreign key (tenant_id, project_id) references public.projects(tenant_id, id),
  foreign key (tenant_id, facebook_page_record_id) references public.facebook_pages(tenant_id, id)
);
create trigger meta_ad_project_mappings_set_updated_at before update on public.meta_ad_project_mappings for each row execute function public.set_updated_at();

alter table public.lead_data add constraint lead_data_tenant_project_fk
  foreign key (tenant_id, project_id) references public.projects(tenant_id, id);

create table if not exists public.lead_project_assignment_audit (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  lead_id uuid not null, previous_project_id uuid, new_project_id uuid, changed_by_user_id uuid not null,
  reason text, changed_at timestamptz not null default now(),
  foreign key (tenant_id, lead_id) references public.lead_data(tenant_id, id),
  foreign key (tenant_id, previous_project_id) references public.projects(tenant_id, id),
  foreign key (tenant_id, new_project_id) references public.projects(tenant_id, id),
  foreign key (tenant_id, changed_by_user_id) references public.tenant_memberships(tenant_id, user_id)
);

create or replace function public.audit_lead_project_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actor uuid; reason text;
begin
  if new.project_id is not distinct from old.project_id or (old.project_id is null and new.project_id is not null) then return new; end if;
  actor := nullif(current_setting('app.current_user_id', true), '')::uuid;
  reason := nullif(current_setting('app.project_assignment_reason', true), '');
  if actor is null then raise exception 'Authenticated actor context is required for project reassignment' using errcode = '42501'; end if;
  insert into public.lead_project_assignment_audit (tenant_id, lead_id, previous_project_id, new_project_id, changed_by_user_id, reason)
    values (new.tenant_id, new.id, old.project_id, new.project_id, actor, reason);
  return new;
end;
$$;
create trigger audit_lead_project_assignment before update of project_id on public.lead_data
  for each row execute function public.audit_lead_project_assignment();

-- Existing and new leads use the same contact-field projection. field_data is untouched.
create or replace function public.extract_meta_lead_contact_fields(p_fields jsonb)
returns table(lead_name text, lead_email text, lead_phone text, lead_phone_normalized text)
language sql immutable set search_path = '' as $$
  with values_by_name as (
    select value->>'name' as key, nullif(btrim((value->'values'->>0)), '') as value
    from jsonb_array_elements(p_fields) value
  ), contact as (
    select max(value) filter (where key = 'full_name') as full_name,
      max(value) filter (where key = 'first_name') as first_name,
      max(value) filter (where key = 'last_name') as last_name,
      max(value) filter (where key = 'email') as email,
      max(value) filter (where key = 'phone_number') as phone from values_by_name
  ) select coalesce(full_name, nullif(btrim(concat_ws(' ', first_name, last_name)), '')), email, phone,
    case when phone is null then null
      when regexp_replace(phone, '[^0-9]', '', 'g') like '91%' then regexp_replace(phone, '[^0-9]', '', 'g')
      when regexp_replace(phone, '[^0-9]', '', 'g') like '0__________' then '91' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 2)
      when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10 then '91' || regexp_replace(phone, '[^0-9]', '', 'g')
      else regexp_replace(phone, '[^0-9]', '', 'g') end from contact;
$$;
update public.lead_data l set (lead_name, lead_email, lead_phone, lead_phone_normalized) =
  (select lead_name, lead_email, lead_phone, lead_phone_normalized from public.extract_meta_lead_contact_fields(l.field_data))
where lead_name is null and lead_email is null and lead_phone is null;

create or replace function public.populate_meta_lead_contact_fields()
returns trigger language plpgsql set search_path = '' as $$
begin
  select lead_name, lead_email, lead_phone, lead_phone_normalized into new.lead_name, new.lead_email, new.lead_phone, new.lead_phone_normalized
  from public.extract_meta_lead_contact_fields(new.field_data);
  if TG_OP = 'UPDATE' and old.ad_name_snapshot is not null then new.ad_name_snapshot := old.ad_name_snapshot; end if;
  return new;
end;
$$;
create trigger populate_meta_lead_contact_fields before insert or update of field_data, ad_name_snapshot on public.lead_data
  for each row execute function public.populate_meta_lead_contact_fields();

create index if not exists lead_data_name_trgm_idx on public.lead_data using gin (lead_name gin_trgm_ops);
create index if not exists lead_data_email_trgm_idx on public.lead_data using gin (lead_email gin_trgm_ops);
create index if not exists lead_data_phone_idx on public.lead_data (lead_phone_normalized text_pattern_ops);
create index if not exists lead_data_tenant_created_idx on public.lead_data (tenant_id, lead_created_time desc, id desc);
create index if not exists lead_data_tenant_project_created_idx on public.lead_data (tenant_id, project_id, lead_created_time desc, id desc);

alter table public.projects enable row level security;
alter table public.meta_ad_project_mappings enable row level security;
alter table public.lead_project_assignment_audit enable row level security;
revoke all on public.projects, public.meta_ad_project_mappings, public.lead_project_assignment_audit from anon, authenticated;
grant select, insert, update on public.projects, public.meta_ad_project_mappings to service_role;
grant select, insert on public.lead_project_assignment_audit to service_role;

-- Preserve the Phase 2 worker contract while adding derived fields and mapping resolution.
create or replace function public.complete_meta_lead_retrieval_event(
    p_event_id uuid, p_field_data jsonb, p_custom_disclaimer_responses jsonb,
    p_raw_lead_payload jsonb, p_retrieved_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare event_row public.meta_webhook_notification_events; resolved_project_id uuid;
begin
  select * into event_row from public.meta_webhook_notification_events where id = p_event_id for update;
  if event_row.id is null then raise exception 'Webhook notification event not found'; end if;
  if event_row.processing_status <> 'processing' then raise exception 'Webhook notification event is not claimed'; end if;
  select project_id into resolved_project_id from public.meta_ad_project_mappings
    where tenant_id = event_row.tenant_id and ad_id = event_row.ad_id;
  insert into public.lead_data (tenant_id, webhook_notification_event_id, leadgen_id, facebook_page_record_id, facebook_page_id, form_id, ad_id, lead_created_time, field_data, custom_disclaimer_responses, raw_lead_payload, retrieved_at, project_id)
  values (event_row.tenant_id, event_row.id, event_row.leadgen_id, event_row.facebook_page_record_id, event_row.facebook_page_id, event_row.form_id, event_row.ad_id, event_row.lead_created_time, p_field_data, p_custom_disclaimer_responses, p_raw_lead_payload, p_retrieved_at, resolved_project_id)
  on conflict (leadgen_id) do nothing;
  update public.meta_webhook_notification_events set processing_status = 'completed', completed_at = now(), processing_started_at = null, next_retrieval_attempt_at = null, last_error_code = null, last_error_message = null where id = event_row.id;
end;
$$;
