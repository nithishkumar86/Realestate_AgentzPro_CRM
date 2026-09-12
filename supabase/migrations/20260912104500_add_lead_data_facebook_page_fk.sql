-- Restores the foreign key the lead query has always assumed exists.
--
-- src/lib/server/lead-query-service.ts selects the page name as an embedded resource:
--
--     facebook_pages!lead_data_facebook_page_record_id_fkey(facebook_page_name)
--
-- PostgREST resolves an embed by foreign key, using that constraint name as the hint. No such
-- constraint was ever created — lead_data reached facebook_pages only indirectly, through the
-- composite key into meta_webhook_notification_events — so every lead query failed with
-- PGRST200 ("Could not find a relationship between 'lead_data' and 'facebook_pages'"), surfacing
-- as LEAD_QUERY_FAILED / 500 on both the leads table and the CSV export.
--
-- It stayed invisible because the tenants carried the default 'UTC' timezone, which
-- getTenantTimezone rejects first with a 503, and because every test double mocks the Supabase
-- client, so the select string was never checked against the real schema.
--
-- The key is composite and tenant-scoped, matching lead_data_tenant_project_fk and the page
-- reference in meta_ad_project_mappings: a lead can only point at a page belonging to its own
-- tenant, so the embed can never cross a tenant boundary. ON DELETE RESTRICT matches the
-- existing page reference in meta_webhook_notification_events — a page that still holds leads
-- cannot be deleted out from under them.
alter table public.lead_data
  add constraint lead_data_facebook_page_record_id_fkey
  foreign key (tenant_id, facebook_page_record_id)
  references public.facebook_pages (tenant_id, id)
  on delete restrict;
