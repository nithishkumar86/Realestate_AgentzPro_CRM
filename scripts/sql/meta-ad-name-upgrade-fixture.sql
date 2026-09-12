-- Seed legacy rows immediately before the additive ad-name migration.
insert into public.tenants(tenant_id, tenant_name) values ('11000000-0000-0000-0000-000000000001', 'Upgrade Fixture');
insert into public.meta_connections(id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted)
values ('22000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'upgrade-user', 'fixture');
insert into public.facebook_pages(id, tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, page_access_token_encrypted, connected_at)
values ('33000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', 'upgrade-page', 'Upgrade Page', 'fixture', now() - interval '1 day');
insert into public.projects(id, tenant_id, project_name) values ('44000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'Legacy Project');
insert into public.meta_webhook_notification_events(id, tenant_id, facebook_page_record_id, facebook_page_id, meta_entry_id, meta_entry_time, leadgen_id, form_id, lead_created_time, raw_webhook_change, processing_status, completed_at)
values ('55000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'upgrade-page', 'upgrade-entry', now(), 'upgrade-lead', 'upgrade-form', now(), '{}', 'completed', now());
insert into public.lead_data(id, tenant_id, webhook_notification_event_id, leadgen_id, facebook_page_record_id, facebook_page_id, form_id, ad_id, lead_created_time, field_data, raw_lead_payload, project_id, ad_name_snapshot)
values ('66000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-000000000001', 'upgrade-lead', '33000000-0000-0000-0000-000000000001', 'upgrade-page', 'upgrade-form', 'upgrade-ad', now(), '[{"name":"email","values":["legacy@example.com"]}]', '{}', '44000000-0000-0000-0000-000000000001', 'Legacy Ad Name');
