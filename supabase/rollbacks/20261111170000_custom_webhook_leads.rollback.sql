-- ROLLBACK for supabase/migrations/20261111170000_custom_webhook_leads.sql. Never applied automatically: this folder
-- is not supabase/migrations. Run by hand, only on the owner's explicit OK, only if the custom webhook migration has
-- to be undone.
--
-- What it restores, exactly as live on prod before the custom webhook migration (read 2026-11-11 with
-- pg_get_constraintdef):
--   lead_data_lead_source_check     facebook | telecaller | google_ads
--   lead_data_source_fields_check   facebook, telecaller and google_ads branches, unchanged text
-- and drops every object the custom webhook migration created.
--
-- ORDER: the app code on branch feature/custom-webhook-leads reads lead_data.custom_lead_ref and custom_source_name
-- on the leads page. If that code is live, revert/redeploy the app WITHOUT it first, then run this file. Running this
-- while that code is live breaks the leads page for every tenant, Meta and Google leads included.
--
-- Safety: it refuses to run while any webhook lead exists, because the restored checks would reject those rows.
-- Deleting customer leads is a separate decision for the owner, never part of a rollback. (If the owner decides to
-- delete them: lead_activities, lead_label_classifications, lead_notes and lead_tasks cascade with the lead, but
-- lead_project_assignment_audit is NO ACTION, so its rows for those leads must be removed first.)
--
-- Locks: ALTER TABLE lead_data takes ACCESS EXCLUSIVE for the few milliseconds the catalog changes need; the restored
-- checks are added NOT VALID and validated afterwards (SHARE UPDATE EXCLUSIVE, does not block reads or writes).

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.lead_data where lead_source = 'custom_webhook') then
    raise exception 'Webhook leads exist; rollback refused. Decide what to do with them first.';
  end if;
end;
$$;

drop function if exists public.ingest_custom_webhook_lead(uuid, uuid, text, text, jsonb, jsonb);

alter table public.lead_data drop constraint if exists lead_data_custom_webhook_fields_check;
alter table public.lead_data drop constraint if exists lead_data_custom_webhook_fk;

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

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller', 'google_ads')) not valid;

drop index if exists public.lead_data_tenant_custom_lead_ref_key;
drop index if exists public.lead_data_tenant_custom_webhook_idx;

alter table public.lead_data
  drop column if exists custom_webhook_id,
  drop column if exists custom_lead_ref,
  drop column if exists custom_source_name;

drop table if exists public.custom_lead_webhooks;

notify pgrst, 'reload schema';

commit;

alter table public.lead_data validate constraint lead_data_lead_source_check;
alter table public.lead_data validate constraint lead_data_source_fields_check;
