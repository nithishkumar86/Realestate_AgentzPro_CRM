-- Regression tests for the AI label-classification pipeline: the compulsory
-- classification row on insert, the automatic label_source tagging on
-- every label write (ai vs telecaller), the "telecaller always wins" rule,
-- and the claim/lease/retry/recover cycle used by the periodic worker.
begin;
set local statement_timeout = '30s';
create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %', message; end if; end;
$$;

insert into public.tenants(tenant_id, tenant_name) values ('50000000-0000-0000-0000-000000000001', 'Label Regression');
insert into public.meta_connections(id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted)
values ('50000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', 'user', 'fixture');
insert into public.facebook_pages(id, tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, page_access_token_encrypted, connected_at)
values ('50000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 'page', 'Page', 'fixture', now() - interval '1 day');

-- Creates one lead through the real webhook -> claim -> complete RPC chain
-- (not a direct INSERT into lead_data), so Trigger A fires exactly the way
-- it will in production.
create function pg_temp.new_lead(p_tenant uuid) returns uuid language plpgsql as $$
declare event_id uuid; claimed public.meta_webhook_notification_events; lead_id uuid;
begin
  insert into public.meta_webhook_notification_events(tenant_id, facebook_page_record_id, facebook_page_id,
    meta_entry_id, meta_entry_time, leadgen_id, form_id, lead_created_time, raw_webhook_change)
  values (p_tenant, '50000000-0000-0000-0000-000000000003', 'page', 'entry', now(), gen_random_uuid()::text, 'form', now(), '{}')
  returning id into event_id;
  select * into claimed from public.claim_meta_webhook_notification_event(event_id);
  perform public.complete_meta_lead_retrieval_event(event_id, claimed.claim_token, '[]', null, '{}', now(), null);
  select id into lead_id from public.lead_data where webhook_notification_event_id = event_id;
  return lead_id;
end;
$$;

-- The disposable cluster already has historical leads queued from earlier
-- fixtures in this same test run (this migration's own backfill classifies
-- them 'pending' too), so claim_due_label_classification() is not
-- guaranteed to hand back a specific test's own lead first. This drains
-- whatever unrelated job comes back (a neutral pass-through completion)
-- until the target lead is claimed, exactly as a real worker processing a
-- shared queue would.
create function pg_temp.claim_until(p_lead_id uuid) returns public.lead_label_classifications language plpgsql as $$
declare claimed public.lead_label_classifications; attempts integer := 0;
begin
  loop
    attempts := attempts + 1;
    select * into claimed from public.claim_due_label_classification();
    if claimed.lead_id is null then
      raise exception 'claim_until: queue drained before finding %', p_lead_id;
    end if;
    if claimed.lead_id = p_lead_id then
      return claimed;
    end if;
    perform public.complete_label_classification(claimed.lead_id, claimed.tenant_id, claimed.claim_token, claimed.final_label, 0.5, 'noise drain');
    if attempts > 500 then
      raise exception 'claim_until: exceeded attempt budget looking for %', p_lead_id;
    end if;
  end loop;
end;
$$;

do $$
declare v_lead_id uuid; other_tenant uuid := '50000000-0000-0000-0000-000000000099'; classification public.lead_label_classifications; claimed public.lead_label_classifications;
begin
  -- TC1: insert compulsorily creates the classification row, defaulted.
  v_lead_id := pg_temp.new_lead('50000000-0000-0000-0000-000000000001');
  select * into classification from public.lead_label_classifications where lead_id = v_lead_id;
  perform pg_temp.assert_true(classification.lead_id is not null, 'TC1: classification row created on insert');
  perform pg_temp.assert_true(classification.final_label = 'Warm' and classification.label_source = 'default' and classification.status = 'pending', 'TC1: classification row defaulted');

  -- TC2: a telecaller-style direct UPDATE (exactly what PATCH /api/leads/[id] does) is
  -- auto-tagged 'telecaller' and synced into both tables.
  update public.lead_data set label = 'Hot' where id = v_lead_id;
  perform pg_temp.assert_true((select label_source = 'telecaller' from public.lead_data where id = v_lead_id), 'TC2: lead_data auto-tagged telecaller');
  select * into classification from public.lead_label_classifications where lead_id = v_lead_id;
  perform pg_temp.assert_true(classification.final_label = 'Hot' and classification.label_source = 'telecaller'
    and classification.telecaller_label = 'Hot' and classification.telecaller_updated_at is not null, 'TC2: classification synced to telecaller');

  -- TC3: AI completing a classification for a lead nobody has touched applies the label
  -- and is auto-tagged 'ai'.
  v_lead_id := pg_temp.new_lead('50000000-0000-0000-0000-000000000001');
  claimed := pg_temp.claim_until(v_lead_id);
  perform pg_temp.assert_true(claimed.lead_id = v_lead_id and claimed.status = 'processing', 'TC3: claim returns the pending row');
  perform pg_temp.assert_true(public.complete_label_classification(claimed.lead_id, claimed.tenant_id, claimed.claim_token, 'Cold', 0.9, 'Low intent language'), 'TC3: completion accepted');
  perform pg_temp.assert_true((select label = 'Cold' and label_source = 'ai' from public.lead_data where id = v_lead_id), 'TC3: lead_data updated by AI');
  select * into classification from public.lead_label_classifications where lead_id = v_lead_id;
  perform pg_temp.assert_true(classification.ai_label = 'Cold' and classification.final_label = 'Cold' and classification.label_source = 'ai' and classification.status = 'completed', 'TC3: classification row updated by AI');

  -- TC4: once a telecaller owns the label, a later AI completion still records ai_label
  -- for reference but must never move final_label/label_source/lead_data.label.
  update public.lead_data set label = 'Not Interested' where id = v_lead_id;
  update public.lead_label_classifications set status = 'pending', claim_token = null, lease_expires_at = null, next_retry_at = clock_timestamp() where lead_id = v_lead_id;
  claimed := pg_temp.claim_until(v_lead_id);
  perform pg_temp.assert_true(claimed.lead_id = v_lead_id, 'TC4: claim picks the re-queued row');
  perform public.complete_label_classification(claimed.lead_id, claimed.tenant_id, claimed.claim_token, 'Hot', 0.5, 'Reopened interest');
  perform pg_temp.assert_true((select label = 'Not Interested' and label_source = 'telecaller' from public.lead_data where id = v_lead_id), 'TC4: telecaller label never overwritten by AI');
  select * into classification from public.lead_label_classifications where lead_id = v_lead_id;
  perform pg_temp.assert_true(classification.ai_label = 'Hot' and classification.final_label = 'Not Interested' and classification.label_source = 'telecaller', 'TC4: AI opinion recorded without moving the final label');

  -- TC5: a stale claim token can neither complete nor fail the job.
  v_lead_id := pg_temp.new_lead('50000000-0000-0000-0000-000000000001');
  select * into claimed from public.claim_due_label_classification();
  perform pg_temp.assert_true(not public.complete_label_classification(claimed.lead_id, claimed.tenant_id, gen_random_uuid(), 'Hot', 0.5, 'x'), 'TC5: stale claim token rejected on complete');
  perform pg_temp.assert_true(not public.schedule_label_classification_retry(claimed.lead_id, claimed.tenant_id, gen_random_uuid(), 'retry_scheduled', clock_timestamp(), 'X', 'x'), 'TC5: stale claim token rejected on retry');

  -- TC6: the right lead under the wrong tenant is rejected (composite identity check).
  perform pg_temp.assert_true(not public.complete_label_classification(claimed.lead_id, other_tenant, claimed.claim_token, 'Hot', 0.5, 'x'), 'TC6: wrong tenant rejected');

  -- TC7: retry scheduling, then exhaustion after repeated transient failures.
  perform public.schedule_label_classification_retry(claimed.lead_id, claimed.tenant_id, claimed.claim_token, 'retry_scheduled', clock_timestamp() + interval '1 minute', 'TRANSIENT', 'temporary');
  perform pg_temp.assert_true((select status = 'retry_scheduled' and next_retry_at is not null from public.lead_label_classifications where lead_id = claimed.lead_id), 'TC7: retry scheduled');
  update public.lead_label_classifications set retry_count = 6, next_retry_at = clock_timestamp() where lead_id = claimed.lead_id;
  select * into claimed from public.claim_due_label_classification();
  perform public.schedule_label_classification_retry(claimed.lead_id, claimed.tenant_id, claimed.claim_token, 'retry_scheduled', clock_timestamp() + interval '1 minute', 'TRANSIENT', 'temporary');
  perform pg_temp.assert_true((select status = 'failed' and next_retry_at is null from public.lead_label_classifications where lead_id = claimed.lead_id), 'TC7: sixth failure exhausts to failed');

  -- TC8: an abandoned lease is recovered back to retry_scheduled.
  v_lead_id := pg_temp.new_lead('50000000-0000-0000-0000-000000000001');
  claimed := pg_temp.claim_until(v_lead_id);
  update public.lead_label_classifications set lease_expires_at = clock_timestamp() - interval '1 minute' where lead_id = v_lead_id;
  perform public.recover_label_classifications();
  perform pg_temp.assert_true((select status = 'retry_scheduled' and claim_token is null and next_retry_at <= clock_timestamp() from public.lead_label_classifications where lead_id = v_lead_id), 'TC8: expired lease recovered');

  -- TC9: a missing classification row (Trigger A failure simulated by direct delete) is
  -- recreated by the defense-in-depth backfill, respecting the lead's current label.
  v_lead_id := pg_temp.new_lead('50000000-0000-0000-0000-000000000001');
  update public.lead_data set label = 'Hot' where id = v_lead_id;
  delete from public.lead_label_classifications where lead_id = v_lead_id;
  perform public.backfill_missing_label_classifications();
  select * into classification from public.lead_label_classifications where lead_id = v_lead_id;
  perform pg_temp.assert_true(classification.lead_id is not null and classification.final_label = 'Hot' and classification.label_source = 'telecaller' and classification.status = 'completed', 'TC9: backfill recreates row from current lead state');
end;
$$;

-- TC10: anon/authenticated have no direct access; only service_role does.
do $$
begin
  perform 1 from information_schema.role_table_grants
    where table_name = 'lead_label_classifications' and grantee in ('anon', 'authenticated');
  if found then raise exception 'TC10: anon/authenticated must not be granted on lead_label_classifications'; end if;
end;
$$;

rollback;
