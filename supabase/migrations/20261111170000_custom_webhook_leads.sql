-- Custom webhook leads: any tool that can send a POST request (website forms, WordPress / Elementor, Zapier, Pabbly,
-- the company's own software) pushes leads into the same lead_data table as Meta, Google Ads and call-in leads.
--
-- One webhook per company. The secret is the URL itself (like 3sigma): its random token is never stored in plain
-- text, only its SHA-256 (url_token_hash, used to find the company) and an AES-GCM copy (encrypted_url_token, so the
-- owner can copy the URL again). The tenant comes only from that lookup, never from the request body.
--
-- Additive only. Nothing Meta, Google Ads or call-in writes changes:
--   1. lead_data gets 3 nullable custom_* columns. Every existing row leaves them NULL. No default, so adding them
--      is a catalog change only (no table rewrite).
--   2. lead_data_lead_source_check and lead_data_source_fields_check are recreated as supersets. The facebook,
--      telecaller and google_ads branches are the live text (pg_get_constraintdef, read 2026-11-11) unchanged; a
--      custom_webhook branch is added. ad_id stays NULL for webhook rows, so the ad assignment rule, the Meta ad
--      filters and the Meta ad-name resolver never see them.
--   3. lead_data_custom_webhook_fields_check (new) keeps the custom_* columns NULL on every other source, without
--      editing the facebook / telecaller / google_ads branches. Meta and Google writers never write these columns.
--   4. custom_lead_webhooks (new) is service-role only (RLS forced, no policies, nothing granted to
--      anon/authenticated), the same model as google_lead_webhooks and lead_data.
--   5. ingest_custom_webhook_lead (new) is the only writer of webhook leads.
-- lead_platform (generated) becomes 'custom_webhook' for these rows and lead_ad_ref stays NULL, so the /leads Source
-- filter and the dashboard's platform view work with no change; get_dashboard_platform_stats_v2 is not touched.
--
-- Contact fields: the webhook route stores answers in Meta's field_data shape and under Meta's keys (full_name,
-- first_name, last_name, email, phone_number), so populate_meta_lead_contact_fields, search, phone normalising and the
-- AI-label redaction work on webhook leads with no change. The existing insert triggers also queue the AI label,
-- write the "Lead created" timeline row and send the live new-lead signal; a webhook lead arrives Unassigned.
--
-- Undo: supabase/rollbacks/20261111170000_custom_webhook_leads.rollback.sql.
--
-- Locks: from the first ALTER TABLE lead_data until COMMIT this transaction holds ACCESS EXCLUSIVE on lead_data
-- (34 rows on prod at 2026-11-11, so milliseconds). lock_timeout makes it fail and roll back cleanly instead of
-- queueing every lead read/write behind it if a long query already holds lead_data. The checks and the foreign key
-- are added NOT VALID and validated after COMMIT (SHARE UPDATE EXCLUSIVE: reads and writes continue).

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The company's webhook.
-- ---------------------------------------------------------------------------
create table public.custom_lead_webhooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (tenant_id) on delete cascade,
  url_token_hash text not null unique check (url_token_hash ~ '^[0-9a-f]{64}$'),
  encrypted_url_token text not null check (encrypted_url_token <> ''),
  is_active boolean not null default true,
  last_lead_received_at timestamptz,
  url_rotated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_lead_webhooks_tenant_id_id_key unique (tenant_id, id)
);

create trigger custom_lead_webhooks_set_updated_at before update on public.custom_lead_webhooks
  for each row execute function public.set_updated_at();

alter table public.custom_lead_webhooks enable row level security;
alter table public.custom_lead_webhooks force row level security;

-- Supabase's default privileges give service_role ALL (including TRUNCATE) on new tables; grant back only what the
-- server uses. Rows are never deleted by the app (Stop switches is_active off); a tenant delete cascades.
revoke all on table public.custom_lead_webhooks from public, anon, authenticated, service_role;
grant select, insert, update on table public.custom_lead_webhooks to service_role;

-- ---------------------------------------------------------------------------
-- lead_data
-- ---------------------------------------------------------------------------
alter table public.lead_data
  add column custom_webhook_id uuid,
  add column custom_lead_ref text,
  add column custom_source_name text;

-- The sender's own lead id ("lead_id"): a repeat of it is never saved twice for the same company.
create unique index lead_data_tenant_custom_lead_ref_key
  on public.lead_data (tenant_id, custom_lead_ref) where custom_lead_ref is not null;
-- Backs the foreign key below (a tenant's cascade delete checks it).
create index lead_data_tenant_custom_webhook_idx
  on public.lead_data (tenant_id, custom_webhook_id) where custom_webhook_id is not null;

-- NO ACTION (checked at the end of the statement), so a tenant's cascade delete, which removes both the leads and the
-- webhook in one statement, always succeeds.
alter table public.lead_data add constraint lead_data_custom_webhook_fk
  foreign key (tenant_id, custom_webhook_id) references public.custom_lead_webhooks (tenant_id, id) not valid;

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller', 'google_ads', 'custom_webhook')) not valid;

-- The facebook, telecaller and google_ads branches below are the live constraint's branches, unchanged.
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
  or
  (lead_source = 'custom_webhook'
    and custom_webhook_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
) not valid;

-- The custom_* columns belong to webhook leads only. Every existing row has them NULL, so it passes.
alter table public.lead_data add constraint lead_data_custom_webhook_fields_check check (
  (custom_webhook_id is null and custom_lead_ref is null and custom_source_name is null)
  or
  (lead_source = 'custom_webhook' and custom_webhook_id is not null
    and (custom_lead_ref is null or char_length(custom_lead_ref) between 1 and 200)
    and (custom_source_name is null or char_length(custom_source_name) between 1 and 200))
) not valid;

-- ---------------------------------------------------------------------------
-- ingest_custom_webhook_lead: the only writer of webhook leads. Called by the public webhook route after it has
-- matched the URL token's hash to this tenant's active webhook and mapped the body. Returns
-- {"outcome": "stored" | "duplicate", "lead_id": <uuid>}.
--   P0002  the webhook is gone, stopped or belongs to another company (the route answers 404)
--   22023  the lead is unusable: no phone and no email, or an over-long source / lead_id (the route answers 400)
-- ---------------------------------------------------------------------------
create function public.ingest_custom_webhook_lead(
  p_tenant_id uuid, p_webhook_id uuid, p_lead_ref text, p_source_name text, p_field_data jsonb, p_raw_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ref text := nullif(pg_catalog.btrim(coalesce(p_lead_ref, '')), '');
  v_source text := nullif(pg_catalog.btrim(coalesce(p_source_name, '')), '');
  v_phone text;
  v_email text;
  v_lead_id uuid;
begin
  if p_field_data is null or pg_catalog.jsonb_typeof(p_field_data) <> 'array' then
    raise exception 'Lead fields must be a list' using errcode = '22023';
  end if;
  if p_raw_payload is null or pg_catalog.jsonb_typeof(p_raw_payload) <> 'object' then
    raise exception 'Lead payload must be an object' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_ref) > 200 or pg_catalog.char_length(v_source) > 200 then
    raise exception 'lead_id and source must be 200 characters or fewer' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.custom_lead_webhooks as w
    where w.id = p_webhook_id and w.tenant_id = p_tenant_id and w.is_active
  ) then
    raise exception 'Custom lead webhook not found' using errcode = 'P0002';
  end if;

  select contact.lead_phone, contact.lead_email into v_phone, v_email
  from public.extract_meta_lead_contact_fields(p_field_data) as contact;
  if v_phone is null and v_email is null then
    raise exception 'Send phone or email' using errcode = '22023';
  end if;

  -- A tool may send the same lead again (a retry), even at the same moment.
  if v_ref is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':custom_lead:' || v_ref, 0));
    select ld.id into v_lead_id from public.lead_data as ld
    where ld.tenant_id = p_tenant_id and ld.custom_lead_ref = v_ref;
    if v_lead_id is not null then
      return pg_catalog.jsonb_build_object('outcome', 'duplicate', 'lead_id', v_lead_id);
    end if;
  end if;

  begin
    insert into public.lead_data (
      tenant_id, lead_source, custom_webhook_id, custom_lead_ref, custom_source_name,
      lead_created_time, field_data, raw_lead_payload, retrieved_at
    ) values (
      p_tenant_id, 'custom_webhook', p_webhook_id, v_ref, v_source,
      pg_catalog.clock_timestamp(), p_field_data, p_raw_payload, pg_catalog.clock_timestamp()
    )
    returning id into v_lead_id;
  exception when unique_violation then
    -- Only lead_data_tenant_custom_lead_ref_key can collide here; anything else is re-raised.
    select ld.id into v_lead_id from public.lead_data as ld
    where v_ref is not null and ld.tenant_id = p_tenant_id and ld.custom_lead_ref = v_ref;
    if v_lead_id is null then
      raise;
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'duplicate', 'lead_id', v_lead_id);
  end;

  update public.custom_lead_webhooks set last_lead_received_at = pg_catalog.clock_timestamp()
  where id = p_webhook_id and tenant_id = p_tenant_id;
  return pg_catalog.jsonb_build_object('outcome', 'stored', 'lead_id', v_lead_id);
end;
$$;

revoke all on function public.ingest_custom_webhook_lead(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_custom_webhook_lead(uuid, uuid, text, text, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;

-- Outside the transaction: validate against every existing row. SHARE UPDATE EXCLUSIVE (reads and writes continue).
-- Every existing row has the custom_* columns NULL and a facebook / telecaller / google_ads source, so all pass.
alter table public.lead_data validate constraint lead_data_custom_webhook_fk;
alter table public.lead_data validate constraint lead_data_lead_source_check;
alter table public.lead_data validate constraint lead_data_source_fields_check;
alter table public.lead_data validate constraint lead_data_custom_webhook_fields_check;
