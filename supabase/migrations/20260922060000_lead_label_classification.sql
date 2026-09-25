-- Adds the compulsory AI label-classification pipeline. Purely additive: no
-- existing table, column, function, or RPC signature is changed. lead_data
-- gains one column (label_source) and three triggers that keep it and the
-- new lead_label_classifications table in sync automatically, so no
-- application code path can forget to record where a label came from.
begin;

alter table public.lead_data
  add column if not exists label_source text not null default 'default'
    check (label_source in ('default', 'ai', 'telecaller'));

-- Required so lead_label_classifications can carry a composite foreign key
-- back to the exact tenant-scoped lead row (belt-and-suspenders against a
-- cross-tenant mapping, on top of the primary key on id alone).
alter table public.lead_data
  add constraint lead_data_id_tenant_key unique (id, tenant_id);

-- label_source was just added with a blanket default of 'default' for every
-- existing row, including leads a telecaller already triaged before this
-- feature existed. Recover that history the only way it is observable now:
-- any lead not still at the factory default label was necessarily changed
-- by a person, since 'Warm' is the only value the pipeline has ever set on
-- its own. This runs once, here, and never again.
update public.lead_data set label_source = 'telecaller'
where label <> 'Warm' and label_source = 'default';

create table public.lead_label_classifications (
  lead_id uuid primary key,
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  ai_label text check (ai_label in ('Hot', 'Warm', 'Cold', 'Not Interested')),
  ai_confidence numeric(3, 2) check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 1)),
  ai_reason text,
  ai_completed_at timestamptz,
  telecaller_label text check (telecaller_label in ('Hot', 'Warm', 'Cold', 'Not Interested')),
  telecaller_updated_at timestamptz,
  final_label text not null default 'Warm' check (final_label in ('Hot', 'Warm', 'Cold', 'Not Interested')),
  label_source text not null default 'default' check (label_source in ('default', 'ai', 'telecaller')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'retry_scheduled', 'failed')),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_retry_at timestamptz default clock_timestamp(),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_label_classifications_lead_fk foreign key (lead_id, tenant_id)
    references public.lead_data (id, tenant_id) on delete cascade,
  constraint lead_label_classifications_claim_lease_check check (
    (claim_token is null) = (lease_expires_at is null)
  ),
  constraint lead_label_classifications_terminal_schedule_check check (
    status not in ('completed', 'failed') or next_retry_at is null
  )
);

create trigger lead_label_classifications_set_updated_at before update on public.lead_label_classifications
  for each row execute function public.set_updated_at();

create index lead_label_classifications_due_idx on public.lead_label_classifications (next_retry_at, tenant_id, lead_id)
  where status in ('pending', 'retry_scheduled');

-- Trigger A: every lead insert compulsorily gets a matching classification
-- row in the same transaction. Wrapped so classification bookkeeping can
-- never block a lead from being stored — if this ever fails, the periodic
-- sweep's backfill step (below) creates the missing row on its next run.
create function public.create_lead_label_classification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    insert into public.lead_label_classifications (tenant_id, lead_id, final_label, label_source, status)
    values (new.tenant_id, new.id, new.label, new.label_source, case when new.label_source = 'telecaller' then 'completed' else 'pending' end)
    on conflict (lead_id) do nothing;
  exception when others then
    null;
  end;
  return new;
end;
$$;

create trigger lead_data_create_label_classification
  after insert on public.lead_data
  for each row execute function public.create_lead_label_classification();

-- Trigger B: decides label_source automatically whenever label is written,
-- so no call site has to remember to set it correctly. The AI-completion
-- RPC below sets a transaction-local flag right before its own UPDATE; any
-- other write path (in particular the existing PATCH /api/leads/[id] route,
-- unchanged by this migration) leaves the flag unset and is classified as
-- 'telecaller' by default. The flag is consumed one-shot: this trigger
-- clears it immediately after reading it, so it can never leak onto a
-- second, unrelated label UPDATE that happens to run later in the same
-- database transaction.
create function public.set_lead_label_source()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.label_source := case when coalesce(current_setting('app.label_source', true), '') = 'ai' then 'ai' else 'telecaller' end;
  perform set_config('app.label_source', '', true);
  return new;
end;
$$;

create trigger lead_data_set_label_source
  before update of label on public.lead_data
  for each row execute function public.set_lead_label_source();

-- Trigger C: the single place that syncs lead_data back into
-- lead_label_classifications, for both the AI path and the telecaller path.
-- A telecaller edit also closes out the job (status='completed', claim
-- released) so the periodic worker never wastes an AI call on a lead a
-- person has already decided, whether that edit lands before the worker
-- ever claims it or while a claim is already in flight (in which case the
-- in-flight worker's later completion is safely rejected by its now-stale
-- claim_token, per the "telecaller always wins" rule).
create function public.sync_lead_label_classification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.lead_label_classifications
  set final_label = new.label,
    label_source = new.label_source,
    status = case when new.label_source = 'telecaller' then 'completed' else status end,
    claim_token = case when new.label_source = 'telecaller' then null else claim_token end,
    lease_expires_at = case when new.label_source = 'telecaller' then null else lease_expires_at end,
    next_retry_at = case when new.label_source = 'telecaller' then null else next_retry_at end,
    telecaller_label = case when new.label_source = 'telecaller' then new.label else telecaller_label end,
    telecaller_updated_at = case when new.label_source = 'telecaller' then clock_timestamp() else telecaller_updated_at end
  where lead_id = new.id and tenant_id = new.tenant_id;
  return new;
end;
$$;

create trigger lead_data_sync_label_classification
  after update of label on public.lead_data
  for each row execute function public.sync_lead_label_classification();

-- Defense-in-depth backfill: creates a classification row for any lead that
-- somehow does not have one (Trigger A failure, or a lead inserted before
-- this migration). Called once below for the historical backfill, and again
-- on every periodic sweep run by the worker.
create function public.backfill_missing_label_classifications()
returns integer language plpgsql security definer set search_path = '' as $$
declare inserted integer;
begin
  insert into public.lead_label_classifications (tenant_id, lead_id, final_label, label_source, status, next_retry_at)
  select lead.tenant_id, lead.id, lead.label, lead.label_source,
    case when lead.label_source = 'telecaller' then 'completed' else 'pending' end,
    case when lead.label_source = 'telecaller' then null else clock_timestamp() end
  from public.lead_data as lead
  left join public.lead_label_classifications as classification on classification.lead_id = lead.id
  where classification.lead_id is null
  on conflict (lead_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

create function public.claim_due_label_classification()
returns public.lead_label_classifications language plpgsql security definer set search_path = '' as $$
declare claimed_row public.lead_label_classifications;
begin
  with candidate as (
    select lead_id from public.lead_label_classifications
    where status in ('pending', 'retry_scheduled')
      and next_retry_at <= clock_timestamp()
      and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
    order by next_retry_at, lead_id
    for update skip locked limit 1
  ) update public.lead_label_classifications as classification
  set claim_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes',
    status = 'processing', retry_count = classification.retry_count + 1
  from candidate
  where classification.lead_id = candidate.lead_id
  returning classification.* into claimed_row;
  return claimed_row;
end;
$$;

-- Records the AI's classification and, unless a telecaller already owns
-- this lead's label, applies it to lead_data. The transaction-local flag is
-- what tells Trigger B this write came from the AI rather than a person.
-- lead_label_classifications.final_label/label_source are deliberately not
-- set here directly — Trigger C is the single place that does that, for
-- every write path, so the two tables can never drift apart from a call
-- site forgetting to set one of them.
create function public.complete_label_classification(
  p_lead_id uuid, p_tenant_id uuid, p_claim_token uuid,
  p_ai_label text, p_ai_confidence numeric, p_ai_reason text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare classification public.lead_label_classifications;
begin
  if p_ai_label not in ('Hot', 'Warm', 'Cold', 'Not Interested') then
    raise exception 'Invalid AI label' using errcode = '22023';
  end if;
  select * into classification from public.lead_label_classifications
  where lead_id = p_lead_id and tenant_id = p_tenant_id for update;
  if classification.lead_id is null or classification.claim_token is distinct from p_claim_token
    or classification.lease_expires_at <= clock_timestamp() then
    return false;
  end if;

  update public.lead_label_classifications
  set ai_label = p_ai_label, ai_confidence = p_ai_confidence, ai_reason = left(coalesce(p_ai_reason, ''), 200),
    ai_completed_at = clock_timestamp(), status = 'completed', claim_token = null, lease_expires_at = null,
    next_retry_at = null, last_error_code = null, last_error_message = null
  where lead_id = p_lead_id and tenant_id = p_tenant_id;

  perform set_config('app.label_source', 'ai', true);
  update public.lead_data set label = p_ai_label
  where id = p_lead_id and tenant_id = p_tenant_id and label_source <> 'telecaller';
  -- Cleared unconditionally: if the UPDATE above matched zero rows (already
  -- telecaller-owned), Trigger B never fires to consume the flag, and it
  -- must not survive to affect a later, unrelated label write in the same
  -- database transaction.
  perform set_config('app.label_source', '', true);

  return true;
end;
$$;

create function public.schedule_label_classification_retry(
  p_lead_id uuid, p_tenant_id uuid, p_claim_token uuid, p_status text,
  p_next_retry_at timestamptz, p_error_code text, p_error_message text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare classification public.lead_label_classifications; terminal_status text;
begin
  if p_status not in ('retry_scheduled', 'failed') then
    raise exception 'Invalid classification outcome' using errcode = '22023';
  end if;
  select * into classification from public.lead_label_classifications
  where lead_id = p_lead_id and tenant_id = p_tenant_id for update;
  if classification.lead_id is null or classification.claim_token is distinct from p_claim_token
    or classification.lease_expires_at <= clock_timestamp() then
    return false;
  end if;
  terminal_status := case when p_status = 'retry_scheduled' and classification.retry_count >= 6 then 'failed' else p_status end;
  if terminal_status = 'retry_scheduled' and p_next_retry_at is null then
    raise exception 'Retry timestamp is required' using errcode = '22023';
  end if;
  update public.lead_label_classifications
  set status = terminal_status, claim_token = null, lease_expires_at = null,
    next_retry_at = case when terminal_status = 'retry_scheduled' then p_next_retry_at else null end,
    last_error_code = left(coalesce(p_error_code, 'AI_LABEL_CLASSIFICATION_FAILED'), 120),
    last_error_message = left(coalesce(p_error_message, 'The lead could not be classified.'), 500)
  where lead_id = p_lead_id and tenant_id = p_tenant_id;
  return true;
end;
$$;

create function public.recover_label_classifications()
returns integer language plpgsql security definer set search_path = '' as $$
declare recovered integer;
begin
  update public.lead_label_classifications set status = 'retry_scheduled', claim_token = null,
    lease_expires_at = null, next_retry_at = clock_timestamp(),
    last_error_code = 'WORKER_LEASE_EXPIRED', last_error_message = 'The label classification worker lease expired before completion.'
  where claim_token is not null and lease_expires_at <= clock_timestamp();
  get diagnostics recovered = row_count;
  return recovered;
end;
$$;

-- One-time historical backfill so leads already stored before this
-- migration also get a classification row (and, if still at the default
-- label, eventually get AI-classified by the periodic sweep).
select public.backfill_missing_label_classifications();

alter table public.lead_label_classifications enable row level security;
alter table public.lead_label_classifications force row level security;
revoke all on public.lead_label_classifications from public, anon, authenticated;
grant select, insert, update on public.lead_label_classifications to service_role;
revoke all on function public.backfill_missing_label_classifications() from public, anon, authenticated;
revoke all on function public.claim_due_label_classification() from public, anon, authenticated;
revoke all on function public.complete_label_classification(uuid, uuid, uuid, text, numeric, text) from public, anon, authenticated;
revoke all on function public.schedule_label_classification_retry(uuid, uuid, uuid, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.recover_label_classifications() from public, anon, authenticated;
grant execute on function public.backfill_missing_label_classifications() to service_role;
grant execute on function public.claim_due_label_classification() to service_role;
grant execute on function public.complete_label_classification(uuid, uuid, uuid, text, numeric, text) to service_role;
grant execute on function public.schedule_label_classification_retry(uuid, uuid, uuid, text, timestamptz, text, text) to service_role;
grant execute on function public.recover_label_classifications() to service_role;

commit;
