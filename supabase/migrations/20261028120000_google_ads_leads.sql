-- Google Ads lead-form leads, next to the Meta and call-in leads, in the same lead_data table.
--
-- Google POSTs every lead (with all its answers) to a per-tenant webhook URL with the advertiser's google_key
-- (https://developers.google.com/google-ads/webhook/docs/implementation). Unlike Meta there is nothing to fetch
-- afterwards, so the lead is saved in the webhook request itself, by ingest_google_lead in one transaction.
-- Only the campaign / ad group names are looked up later, through the Google Ads API, by a worker.
--
-- Additive only. Nothing Meta or call-in writes changes:
--   1. lead_data gets 7 nullable google_* columns. Every existing row leaves them NULL.
--   2. lead_data_lead_source_check and lead_data_source_fields_check are recreated as supersets. The facebook
--      and telecaller branches are the live text unchanged, plus "google_* is null", which every existing row
--      already satisfies. ad_id stays NULL for Google rows, so the Meta ad cache, the ad assignment rules and
--      the 'unattributed' filter (all keyed on ad_id) never see a Google lead.
--   3. New tables, all service-role only (RLS forced, no policies, nothing granted to anon/authenticated),
--      the same model as lead_data.
--   4. get_dashboard_stats: the live body unchanged, plus a "Google Ads" page bucket and topAds bucket.
--
-- Contact fields: the webhook route stores Google's answers in Meta's field_data shape and under Meta's keys
-- (full_name, first_name, last_name, email, phone_number), so populate_meta_lead_contact_fields, search,
-- tasks, push and the AI-label redaction all work on Google leads with no change.
--
-- ad_name stays NULL until the real campaign name is known: populate_meta_lead_contact_fields never lets a set
-- ad_name change, so a placeholder written first would block the real name forever. The app shows the
-- placeholder text instead.
--
-- The every-minute name worker job is a separate migration (20261028130000_google_ads_lead_names_cron.sql),
-- applied only after the worker route is live.
--
-- Undo: supabase/rollbacks/20261028120000_google_ads_leads.rollback.sql.
--
-- Locks: from the first ALTER TABLE lead_data until COMMIT this transaction holds ACCESS EXCLUSIVE on
-- lead_data (the index builds and FK check run inside it). lock_timeout makes it fail and roll back cleanly
-- instead of queueing every lead read/write behind it if a long query already holds lead_data.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Google sign-in (OAuth): one per tenant. Disconnect revokes the token at Google and clears it here.
-- ---------------------------------------------------------------------------
create table public.google_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (tenant_id) on delete cascade,
  google_sub text not null,
  google_email text not null,
  encrypted_refresh_token text,
  granted_scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'revoked')),
  connected_by_user_id uuid,
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_connections_tenant_id_id_key unique (tenant_id, id),
  constraint google_connections_token_check check ((status = 'active') = (encrypted_refresh_token is not null)),
  constraint google_connections_connected_by_fk foreign key (tenant_id, connected_by_user_id)
    references public.tenant_memberships (tenant_id, user_id) on delete set null (connected_by_user_id)
);

-- Google Ads accounts the owner picked. login_customer_id is the manager account the account is reached
-- through (sent as the login-customer-id header); NULL means the user has direct access.
create table public.google_ads_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
  customer_id text not null check (customer_id ~ '^[0-9]{10}$'),
  descriptive_name text,
  is_manager boolean not null default false,
  login_customer_id text check (login_customer_id is null or login_customer_id ~ '^[0-9]{10}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_ads_accounts_tenant_customer_key unique (tenant_id, customer_id)
);

-- Campaign / ad group / asset group names already looked up, and which account owns each one (the webhook
-- carries ids only and no account id).
create table public.google_ads_entity_names (
  tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
  entity_type text not null check (entity_type in ('campaign', 'ad_group', 'asset_group')),
  entity_id text not null check (entity_id ~ '^[0-9]+$'),
  customer_id text not null check (customer_id ~ '^[0-9]{10}$'),
  name text not null,
  fetched_at timestamptz not null default now(),
  primary key (tenant_id, entity_type, entity_id)
);

-- The tenant's webhook: url_token goes in the URL, google_key is what the owner pastes into Google Ads.
-- The key is encrypted (not hashed) so the owner can copy it again from the Connection page.
create table public.google_lead_webhooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (tenant_id) on delete cascade,
  url_token text not null unique check (url_token ~ '^[A-Za-z0-9_-]{43,}$'),
  encrypted_google_key text not null,
  is_active boolean not null default true,
  last_lead_received_at timestamptz,
  last_test_received_at timestamptz,
  key_rotated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_lead_webhooks_tenant_id_id_key unique (tenant_id, id)
);

-- One row per delivery Google made: de-duplication, test-lead receipts and the name-lookup queue. Holds no
-- answers (they are in lead_data.raw_lead_payload only).
--   test            a "Send test data" lead; never written to lead_data
--   names_pending   lead saved; names still to look up. next_name_attempt_at NULL = parked (no Google
--                   connection yet); requeue_google_lead_names releases it on connect.
--   names_resolved  names written, or nothing to look up (no campaign id)
--   names_failed    gave up after 6 attempts; the lead keeps the placeholder name
create table public.google_lead_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
  webhook_id uuid not null,
  google_lead_id text not null,
  is_test boolean not null default false,
  status text not null check (status in ('test', 'names_pending', 'names_resolved', 'names_failed')),
  name_attempts integer not null default 0,
  next_name_attempt_at timestamptz,
  claim_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  received_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_lead_events_tenant_id_id_key unique (tenant_id, id),
  constraint google_lead_events_webhook_fk foreign key (tenant_id, webhook_id)
    references public.google_lead_webhooks (tenant_id, id),
  constraint google_lead_events_test_check check (is_test = (status = 'test'))
);

-- Real leads are de-duplicated per tenant by Google's lead_id; every test delivery is kept.
create unique index google_lead_events_tenant_lead_key
  on public.google_lead_events (tenant_id, google_lead_id) where not is_test;
create index google_lead_events_due_idx
  on public.google_lead_events (next_name_attempt_at) where status = 'names_pending';

create trigger google_connections_set_updated_at before update on public.google_connections
  for each row execute function public.set_updated_at();
create trigger google_ads_accounts_set_updated_at before update on public.google_ads_accounts
  for each row execute function public.set_updated_at();
create trigger google_lead_webhooks_set_updated_at before update on public.google_lead_webhooks
  for each row execute function public.set_updated_at();
create trigger google_lead_events_set_updated_at before update on public.google_lead_events
  for each row execute function public.set_updated_at();

alter table public.google_connections enable row level security;
alter table public.google_connections force row level security;
alter table public.google_ads_accounts enable row level security;
alter table public.google_ads_accounts force row level security;
alter table public.google_ads_entity_names enable row level security;
alter table public.google_ads_entity_names force row level security;
alter table public.google_lead_webhooks enable row level security;
alter table public.google_lead_webhooks force row level security;
alter table public.google_lead_events enable row level security;
alter table public.google_lead_events force row level security;

-- Supabase's default privileges give service_role ALL (including TRUNCATE) on new tables; grant back only
-- what the server uses. google_lead_events is written only by the security-definer functions below.
revoke all on table public.google_connections, public.google_ads_accounts, public.google_ads_entity_names,
  public.google_lead_webhooks, public.google_lead_events from public, anon, authenticated, service_role;
grant select, insert, update on table public.google_connections to service_role;
grant select, insert, update, delete on table public.google_ads_accounts to service_role;
grant select, insert, update, delete on table public.google_ads_entity_names to service_role;
grant select, insert, update on table public.google_lead_webhooks to service_role;
grant select on table public.google_lead_events to service_role;

-- ---------------------------------------------------------------------------
-- lead_data
-- ---------------------------------------------------------------------------
-- Google's int64 ids are kept as text so they never lose precision in JavaScript.
alter table public.lead_data
  add column google_lead_event_id uuid,
  add column google_lead_id text,
  add column google_campaign_id text,
  add column google_adgroup_id text,
  add column google_creative_id text,
  add column google_asset_group_id text,
  add column google_gcl_id text;

create unique index lead_data_tenant_google_lead_id_key
  on public.lead_data (tenant_id, google_lead_id) where google_lead_id is not null;
create unique index lead_data_google_lead_event_id_key
  on public.lead_data (google_lead_event_id) where google_lead_event_id is not null;
create index lead_data_tenant_google_campaign_created_idx
  on public.lead_data (tenant_id, google_campaign_id, lead_created_time desc) where google_campaign_id is not null;

-- NO ACTION (checked at the end of the statement), so a tenant's cascade delete, which removes both the lead
-- and its event in one statement, always succeeds.
alter table public.lead_data add constraint lead_data_google_lead_event_fk
  foreign key (tenant_id, google_lead_event_id) references public.google_lead_events (tenant_id, id);

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller', 'google_ads')) not valid;

-- Only the event link, Google's lead id and the raw payload are required for a Google lead: a payload that
-- arrives without a form or campaign id is still saved (shown as "Unattributed") instead of failing forever.
alter table public.lead_data drop constraint lead_data_source_fields_check;
alter table public.lead_data add constraint lead_data_source_fields_check check (
  (lead_source = 'facebook'
    and webhook_notification_event_id is not null and leadgen_id is not null
    and facebook_page_record_id is not null and facebook_page_id is not null
    and form_id is not null and raw_lead_payload is not null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'telecaller'
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and raw_lead_payload is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'google_ads'
    and google_lead_event_id is not null and google_lead_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null and ad_id is null)
) not valid;

-- ---------------------------------------------------------------------------
-- ingest_google_lead: the only writer of Google leads. Called by the webhook route after it has matched the
-- URL token to this tenant's webhook and checked google_key. Returns 'test', 'duplicate' or 'stored'.
-- Ids of all zeros are treated as absent, as complete_meta_lead_retrieval_event does for Meta's ad_id.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_google_lead(
  p_tenant_id uuid, p_webhook_id uuid, p_google_lead_id text, p_is_test boolean,
  p_form_id text, p_campaign_id text, p_adgroup_id text, p_creative_id text, p_asset_group_id text,
  p_gcl_id text, p_submit_time timestamptz, p_field_data jsonb, p_raw_payload jsonb
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_lead_id text := nullif(pg_catalog.btrim(coalesce(p_google_lead_id, '')), '');
  v_form_id text := nullif(pg_catalog.btrim(coalesce(p_form_id, '')), '');
  v_campaign_id text := nullif(pg_catalog.btrim(coalesce(p_campaign_id, '')), '');
  v_adgroup_id text := nullif(pg_catalog.btrim(coalesce(p_adgroup_id, '')), '');
  v_creative_id text := nullif(pg_catalog.btrim(coalesce(p_creative_id, '')), '');
  v_asset_group_id text := nullif(pg_catalog.btrim(coalesce(p_asset_group_id, '')), '');
  v_gcl_id text := nullif(pg_catalog.btrim(coalesce(p_gcl_id, '')), '');
  v_event_id uuid;
begin
  if v_lead_id is null then
    raise exception 'Google lead id is required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.google_lead_webhooks as w
    where w.id = p_webhook_id and w.tenant_id = p_tenant_id and w.is_active
  ) then
    raise exception 'Google lead webhook not found' using errcode = 'P0002';
  end if;
  if v_form_id ~ '^0+$' then v_form_id := null; end if;
  if v_campaign_id ~ '^0+$' then v_campaign_id := null; end if;
  if v_adgroup_id ~ '^0+$' then v_adgroup_id := null; end if;
  if v_creative_id ~ '^0+$' then v_creative_id := null; end if;
  if v_asset_group_id ~ '^0+$' then v_asset_group_id := null; end if;

  if coalesce(p_is_test, false) then
    insert into public.google_lead_events (tenant_id, webhook_id, google_lead_id, is_test, status)
    values (p_tenant_id, p_webhook_id, v_lead_id, true, 'test');
    update public.google_lead_webhooks set last_test_received_at = pg_catalog.clock_timestamp()
    where id = p_webhook_id and tenant_id = p_tenant_id;
    return 'test';
  end if;

  -- Google may deliver the same lead more than once, even at the same moment.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':google_lead:' || v_lead_id, 0));
  if exists (select 1 from public.google_lead_events as e where e.tenant_id = p_tenant_id and e.google_lead_id = v_lead_id and not e.is_test) then
    return 'duplicate';
  end if;

  insert into public.google_lead_events (tenant_id, webhook_id, google_lead_id, is_test, status, next_name_attempt_at, resolved_at)
  values (
    p_tenant_id, p_webhook_id, v_lead_id, false,
    case when v_campaign_id is null then 'names_resolved' else 'names_pending' end,
    case when v_campaign_id is null then null else pg_catalog.clock_timestamp() end,
    case when v_campaign_id is null then pg_catalog.clock_timestamp() else null end
  )
  returning id into v_event_id;

  insert into public.lead_data (
    tenant_id, lead_source, google_lead_event_id, google_lead_id, form_id, google_campaign_id,
    google_adgroup_id, google_creative_id, google_asset_group_id, google_gcl_id,
    lead_created_time, field_data, raw_lead_payload, retrieved_at
  ) values (
    p_tenant_id, 'google_ads', v_event_id, v_lead_id, v_form_id, v_campaign_id,
    v_adgroup_id, v_creative_id, v_asset_group_id, v_gcl_id,
    coalesce(p_submit_time, pg_catalog.clock_timestamp()), coalesce(p_field_data, '[]'::jsonb), p_raw_payload,
    pg_catalog.clock_timestamp()
  );

  update public.google_lead_webhooks set last_lead_received_at = pg_catalog.clock_timestamp()
  where id = p_webhook_id and tenant_id = p_tenant_id;
  return 'stored';
end;
$$;

-- ---------------------------------------------------------------------------
-- Name worker queue (same claim / lease pattern as the Meta ad-name resolver).
-- ---------------------------------------------------------------------------
create or replace function public.claim_due_google_lead_name()
returns public.google_lead_events language plpgsql security definer set search_path = '' as $$
declare claimed_row public.google_lead_events;
begin
  with candidate as (
    select id from public.google_lead_events
    where status = 'names_pending'
      and next_name_attempt_at <= pg_catalog.clock_timestamp()
      and (lease_expires_at is null or lease_expires_at <= pg_catalog.clock_timestamp())
    order by next_name_attempt_at, id
    for update skip locked limit 1
  ) update public.google_lead_events as event
  set claim_token = gen_random_uuid(), lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes',
    name_attempts = event.name_attempts + 1
  from candidate
  where event.id = candidate.id
  returning event.* into claimed_row;
  return claimed_row;
end;
$$;

-- Writes the name only onto a lead that has none yet.
create or replace function public.complete_google_lead_name(p_event_id uuid, p_tenant_id uuid, p_claim_token uuid, p_ad_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare event_row public.google_lead_events; resolved_name text := nullif(pg_catalog.btrim(coalesce(p_ad_name, '')), '');
begin
  if resolved_name is null then raise exception 'Ad name is required' using errcode = '22023'; end if;
  select * into event_row from public.google_lead_events where id = p_event_id and tenant_id = p_tenant_id for update;
  if event_row.id is null or event_row.claim_token is distinct from p_claim_token
    or event_row.lease_expires_at <= pg_catalog.clock_timestamp() then return false; end if;
  update public.google_lead_events set status = 'names_resolved', claim_token = null, lease_expires_at = null,
    next_name_attempt_at = null, last_error_code = null, resolved_at = pg_catalog.clock_timestamp()
  where id = p_event_id;
  update public.lead_data set ad_name = pg_catalog.left(resolved_name, 500)
  where tenant_id = p_tenant_id and google_lead_event_id = p_event_id and ad_name is null;
  return true;
end;
$$;

-- p_park: the tenant has no usable Google connection. The lead waits (not counted as an attempt) until
-- requeue_google_lead_names runs on connect. Otherwise a retry, or names_failed after 6 attempts.
create or replace function public.schedule_google_lead_name_retry(
  p_event_id uuid, p_tenant_id uuid, p_claim_token uuid, p_next_attempt_at timestamptz, p_error_code text, p_park boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare event_row public.google_lead_events; terminal boolean;
begin
  select * into event_row from public.google_lead_events where id = p_event_id and tenant_id = p_tenant_id for update;
  if event_row.id is null or event_row.claim_token is distinct from p_claim_token
    or event_row.lease_expires_at <= pg_catalog.clock_timestamp() then return false; end if;
  if coalesce(p_park, false) then
    update public.google_lead_events set claim_token = null, lease_expires_at = null, next_name_attempt_at = null,
      name_attempts = greatest(event_row.name_attempts - 1, 0),
      last_error_code = pg_catalog.left(coalesce(p_error_code, 'GOOGLE_CONNECTION_REQUIRED'), 120)
    where id = p_event_id;
    return true;
  end if;
  terminal := event_row.name_attempts >= 6;
  if not terminal and p_next_attempt_at is null then
    raise exception 'Retry timestamp is required' using errcode = '22023';
  end if;
  update public.google_lead_events set claim_token = null, lease_expires_at = null,
    status = case when terminal then 'names_failed' else 'names_pending' end,
    next_name_attempt_at = case when terminal then null else p_next_attempt_at end,
    last_error_code = pg_catalog.left(coalesce(p_error_code, 'GOOGLE_NAME_LOOKUP_FAILED'), 120)
  where id = p_event_id;
  return true;
end;
$$;

-- Releases claims whose worker died before finishing.
create or replace function public.recover_google_lead_names()
returns integer language plpgsql security definer set search_path = '' as $$
declare recovered integer;
begin
  update public.google_lead_events set claim_token = null, lease_expires_at = null,
    next_name_attempt_at = pg_catalog.clock_timestamp(), last_error_code = 'WORKER_LEASE_EXPIRED'
  where status = 'names_pending' and claim_token is not null and lease_expires_at <= pg_catalog.clock_timestamp();
  get diagnostics recovered = row_count;
  return recovered;
end;
$$;

-- On connect / account change: retry every lead of this tenant that is parked or gave up.
create or replace function public.requeue_google_lead_names(p_tenant_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare requeued integer;
begin
  update public.google_lead_events set status = 'names_pending', name_attempts = 0,
    next_name_attempt_at = pg_catalog.clock_timestamp(), last_error_code = null
  where tenant_id = p_tenant_id
    and ((status = 'names_pending' and next_name_attempt_at is null and claim_token is null) or status = 'names_failed');
  get diagnostics requeued = row_count;
  return requeued;
end;
$$;

revoke all on function public.ingest_google_lead(uuid, uuid, text, boolean, text, text, text, text, text, text, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_google_lead(uuid, uuid, text, boolean, text, text, text, text, text, text, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.claim_due_google_lead_name() from public, anon, authenticated;
grant execute on function public.claim_due_google_lead_name() to service_role;
revoke all on function public.complete_google_lead_name(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.complete_google_lead_name(uuid, uuid, uuid, text) to service_role;
revoke all on function public.schedule_google_lead_name_retry(uuid, uuid, uuid, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.schedule_google_lead_name_retry(uuid, uuid, uuid, timestamptz, text, boolean) to service_role;
revoke all on function public.recover_google_lead_names() from public, anon, authenticated;
grant execute on function public.recover_google_lead_names() to service_role;
revoke all on function public.requeue_google_lead_names(uuid) from public, anon, authenticated;
grant execute on function public.requeue_google_lead_names(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- get_dashboard_stats: same signature and body as 20261026170000_lead_source_telecaller_leads.sql, plus
-- Google Ads leads shown as "Google Ads" in byPage and topAds (instead of "Unknown Page" / left out).
-- ---------------------------------------------------------------------------
create or replace function public.get_dashboard_stats(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_month_from timestamptz,
  p_month_to timestamptz,
  p_prev_month_from timestamptz,
  p_prev_month_to timestamptz,
  p_page_record_id uuid,
  p_ad_id text,
  p_status text,
  p_label text,
  p_search text,
  p_search_digits text,
  p_tz text,
  p_granularity text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_pattern text;
  v_result jsonb;
begin
  if p_tenant_id is null then
    raise exception 'tenant is required';
  end if;
  if p_granularity not in ('hour', 'day', 'month') then
    raise exception 'invalid granularity';
  end if;

  -- queryLeads matches ilike '%<raw>%' through PostgREST, which turns '*' into '%'.
  v_pattern := case when p_search is null or p_search = '' then null
                    else '%' || replace(p_search, '*', '%') || '%' end;

  with base as (
    select ld.id, ld.ad_id, ld.ad_name, ld.facebook_page_record_id, ld.lead_created_time, ld.status, ld.label, ld.lead_source
    from public.lead_data as ld
    where ld.tenant_id = p_tenant_id
      and (p_page_record_id is null or ld.facebook_page_record_id = p_page_record_id)
      and (p_ad_id is null
           or (p_ad_id = 'unattributed' and ld.ad_id is null and ld.lead_source = 'facebook')
           or (p_ad_id <> 'unattributed' and ld.ad_id = p_ad_id))
      and (p_status is null or ld.status = p_status)
      and (p_label is null or ld.label = p_label)
      and (v_pattern is null
           or ld.lead_name ilike v_pattern
           or ld.lead_email ilike v_pattern
           or ld.lead_phone ilike v_pattern
           or (p_search_digits is not null and ld.lead_phone_normalized = p_search_digits))
  ), filtered as (
    select * from base b
    where (p_from is null or b.lead_created_time >= p_from)
      and (p_to is null or b.lead_created_time < p_to)
  ), bounds as (
    -- Tenant-local naive timestamps. With a date window the timeline covers exactly that window;
    -- without one it covers the tenant's history, capped at the 24 most recent months.
    select
      case when p_from is not null and p_to is not null
           then date_trunc(p_granularity, p_from at time zone p_tz)
           else greatest(
                  date_trunc('month', coalesce((select min(f.lead_created_time) from filtered f), now()) at time zone p_tz),
                  date_trunc('month', now() at time zone p_tz) - interval '23 months')
      end as s_from,
      case when p_from is not null and p_to is not null
           then date_trunc(p_granularity, (p_to - interval '1 microsecond') at time zone p_tz)
           else date_trunc('month', now() at time zone p_tz)
      end as s_to
  ), per_ad as (
    select f.ad_id,
           (array_agg(f.ad_name order by f.lead_created_time desc) filter (where f.ad_name is not null))[1] as ad_name,
           count(*) as cnt
    from filtered f
    where f.lead_source = 'facebook'
    group by f.ad_id
  ), ranked as (
    select p.ad_id, p.ad_name, p.cnt, row_number() over (order by p.cnt desc, p.ad_id) as rn
    from per_ad p where p.ad_id is not null
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'monthToDate', (select count(*) from base b
                    where b.lead_created_time >= p_month_from and b.lead_created_time < p_month_to),
    'previousMonthSamePeriod', (select count(*) from base b
                    where b.lead_created_time >= p_prev_month_from and b.lead_created_time < p_prev_month_to),
    'byPage', coalesce((
      select jsonb_agg(jsonb_build_object('pageRecordId', x.page_id, 'pageName', x.page_name, 'count', x.cnt)
                       order by x.cnt desc, x.page_name)
      from (
        select f.facebook_page_record_id as page_id,
               case when f.lead_source = 'telecaller' then 'Telecaller'
                    when f.lead_source = 'google_ads' then 'Google Ads'
                    else coalesce(fp.facebook_page_name, 'Unknown Page') end as page_name,
               count(*) as cnt
        from filtered f
        left join public.facebook_pages fp
          on fp.id = f.facebook_page_record_id and fp.tenant_id = p_tenant_id
        group by f.lead_source, f.facebook_page_record_id, fp.facebook_page_name
      ) x
    ), '[]'::jsonb),
    'byLabel', (
      select jsonb_agg(jsonb_build_object('label', l.label, 'count', l.cnt) order by l.ord)
      from (
        select v.label, v.ord, count(f.id) as cnt
        from (values ('Hot', 1), ('Warm', 2), ('Cold', 3), ('Not Interested', 4)) as v(label, ord)
        left join filtered f on f.label = v.label
        group by v.label, v.ord
      ) l
    ),
    'byStatus', (
      select jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt) order by s.ord)
      from (
        select v.status, v.ord, count(f.id) as cnt
        from (values
          ('New Lead', 1), ('Not reachable', 2), ('Working', 3), ('Closed', 4), ('Archived', 5),
          ('Sale', 6), ('Site visit done', 7), ('Next project', 8), ('Site visit pending', 9),
          ('Final call', 10), ('Didn''t pick the call', 11), ('Details send via WhatsApp', 12),
          ('Disqualified', 13), ('Asking Time for Taking Decision', 14)
        ) as v(status, ord)
        left join filtered f on f.status = v.status
        group by v.status, v.ord
      ) s
    ),
    'topAds', coalesce((
      select jsonb_agg(u.item order by u.sort_key) from (
        select jsonb_build_object('adId', r.ad_id, 'name', r.ad_name, 'count', r.cnt) as item, r.rn as sort_key
        from ranked r where r.rn <= 8
        union all
        select jsonb_build_object('adId', 'other', 'name', 'Other', 'count', sum(r.cnt)), 9::bigint
        from ranked r where r.rn > 8 having count(*) > 0
        union all
        select jsonb_build_object('adId', 'unattributed', 'name', 'Unattributed', 'count', p.cnt), 10::bigint
        from per_ad p where p.ad_id is null
        union all
        select jsonb_build_object('adId', 'telecaller', 'name', 'Telecaller', 'count', count(*)), 11::bigint
        from filtered f where f.lead_source = 'telecaller' having count(*) > 0
        union all
        select jsonb_build_object('adId', 'google_ads', 'name', 'Google Ads', 'count', count(*)), 12::bigint
        from filtered f where f.lead_source = 'google_ads' having count(*) > 0
      ) u
    ), '[]'::jsonb),
    'timeline', coalesce((
      select jsonb_agg(jsonb_build_object(
               'bucket', to_char(g.bucket, 'YYYY-MM-DD"T"HH24:MI:SS'), 'count', coalesce(c.cnt, 0))
             order by g.bucket)
      from bounds bd
      cross join lateral generate_series(bd.s_from, bd.s_to, ('1 ' || p_granularity)::interval) as g(bucket)
      left join (
        select date_trunc(p_granularity, f.lead_created_time at time zone p_tz) as bucket, count(*) as cnt
        from filtered f
        group by 1
      ) c on c.bucket = g.bucket
    ), '[]'::jsonb),
    'timelineTruncated', exists (
      select 1 from filtered f, bounds bd
      where date_trunc(p_granularity, f.lead_created_time at time zone p_tz) < bd.s_from
    ),
    'generatedAt', now()
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_dashboard_stats(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.get_dashboard_stats(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, text, text) to service_role;

commit;

-- Outside the transaction: validate the two recreated checks against every existing row. Takes SHARE UPDATE
-- EXCLUSIVE (reads and writes continue). Every existing row has the new google_* columns NULL, so both pass.
alter table public.lead_data validate constraint lead_data_lead_source_check;
alter table public.lead_data validate constraint lead_data_source_fields_check;
