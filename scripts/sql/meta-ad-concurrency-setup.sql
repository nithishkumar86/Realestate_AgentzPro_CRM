create table public.meta_ad_concurrency_results (
  session_name text primary key,
  claim_token uuid,
  claimed_at timestamptz not null default now()
);

insert into public.tenants(tenant_id, tenant_name) values ('13000000-0000-0000-0000-000000000001', 'Concurrency Fixture');
insert into public.meta_connections(id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted)
values ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'concurrency-user', 'fixture');
insert into public.facebook_pages(id, tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, page_access_token_encrypted, connected_at)
values ('33000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001', 'concurrency-page', 'Concurrency Page', 'fixture', now() - interval '1 day');
insert into public.meta_ads(tenant_id, ad_id, source_facebook_page_record_id, resolution_status, next_retry_at)
values ('13000000-0000-0000-0000-000000000001', 'concurrent-ad', '33000000-0000-0000-0000-000000000002', 'pending', now());

insert into public.meta_webhook_notification_events(
  tenant_id, facebook_page_record_id, facebook_page_id, meta_entry_id, meta_entry_time,
  leadgen_id, form_id, lead_created_time, raw_webhook_change
)
select '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000002', 'concurrency-page',
  'concurrency-entry-' || n, now(), 'concurrent-lead-' || n, 'concurrency-form', now(), '{}'
from generate_series(1, 50) as series(n);

do $$
declare event_row record;
begin
  for event_row in select id from public.meta_webhook_notification_events where leadgen_id like 'concurrent-lead-%' loop
    perform public.claim_meta_webhook_notification_event(event_row.id);
  end loop;
end;
$$;
