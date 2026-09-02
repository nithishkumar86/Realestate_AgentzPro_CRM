# Phase 2 — Meta Lead Webhook and Lead Retrieval Production Plan

**System:** Multi-tenant CRM for Meta Lead Ads  
**Status:** Final implementation plan  
**Verified against Meta documentation:** 29 August 2026

## 1. Decision and correction

Phase 2 is not only the database insertion that happens after a webhook arrives. The complete phase includes:

1. Expose one HTTPS callback endpoint.
2. Complete Meta's callback verification handshake using a private verify token.
3. Configure the Meta app for the Page object's `leadgen` webhook field.
4. Subscribe every selected Facebook Page to the app with `subscribed_fields=leadgen`.
5. Verify the authenticity of every webhook POST before trusting it.
6. Parse every `entry[]` and every `changes[]` item.
7. Persist one notification event for each unique `leadgen_id`.
8. Dispatch one independent queue job for each persisted event.
9. Retrieve one complete lead with `GET /{leadgen_id}`.
10. Store the complete lead and mark the event completed atomically.
11. Retry temporary failures and recover events that were persisted but not queued.

The Meta terminology must remain exact:

```text
Webhook field subscribed by the app/Page = leadgen
Identifier delivered inside changes[].value = leadgen_id
Graph API retrieval target = GET /{leadgen_id}
```

We do **not** subscribe to a field named `leadgen_id`.

## 2. Official sources

The implementation must be checked again against the pinned Graph API version before deployment because Meta versions its Graph API.

- [Meta — Lead Ads / Retrieving Leads](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/)
- [Meta — Lead Ads Testing and Troubleshooting](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/testing-troubleshooting/)
- [Meta — Webhook endpoint verification pattern](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/)
- [Meta-maintained API catalogue — Leads Retrieval Setup Checker](https://github.com/facebookincubator/catalogue-of-api-solutions/blob/main/solutions/leads/leads-retrieval-set-up-checker.md)

The last source explicitly identifies these separate checks: configure the app subscription for `object=page` and `field=leadgen`, install the webhook-configured app on the Page through `/{PAGE_ID}/subscribed_apps`, verify that Page subscription, create a test lead, and retrieve the lead.

## 3. Phase 1 prerequisites

Phase 1 remains unchanged. Before enabling Phase 2, the backend must be able to obtain these facts from the existing Phase 1 records:

- The authenticated internal `tenant_id`.
- The selected `facebook_page_id`.
- The selected Page belongs to that tenant.
- The Page connection is active.
- The encrypted Page access token exists and can be decrypted only on the server.
- The token has the permissions required for Page webhook subscription and lead retrieval.

Relevant Meta permissions must be requested only for the operations actually implemented. For this phase, the important operations are Page subscription management and lead retrieval. Permission names and access level must be verified in the Meta App Dashboard and current Meta permission reference before release; do not infer approval from a successful development-mode test.

## 4. Configuration and secrets

Keep the following server-only configuration outside the database tables in this phase:

```text
META_APP_ID
META_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
META_GRAPH_API_VERSION
META_WEBHOOK_CALLBACK_URL
QSTASH credentials/signing keys
```

Rules:

- `META_WEBHOOK_VERIFY_TOKEN` is a private random value created by our application. It is not a Page access token and not the Meta App Secret.
- The callback URL must be public HTTPS.
- The App Secret, verify token, Page tokens and queue credentials must never be returned to the browser or written to logs.
- Pin `META_GRAPH_API_VERSION`; never silently call an unversioned Graph endpoint.

## 5. Webhook endpoint

Use one route with two methods:

```text
GET  /api/webhooks/meta/leadgen  → callback verification only
POST /api/webhooks/meta/leadgen  → webhook notification ingestion only
```

The GET handler must not insert database records. The POST handler must not use the GET verify token as proof that the POST came from Meta.

## 6. Callback verification handshake

When the callback URL is configured, Meta sends query parameters equivalent to:

```text
hub.mode
hub.verify_token
hub.challenge
```

Processing:

```text
Receive GET
→ Require hub.mode = subscribe
→ Compare hub.verify_token with META_WEBHOOK_VERIFY_TOKEN
→ Use a constant-time comparison
→ If valid, return the exact hub.challenge as the response body with HTTP 200
→ If invalid or incomplete, return HTTP 403
```

Do not store the received verify token. Do not log it. Verification proves control of the callback during configuration; it does not authenticate later POST bodies.

## 7. Configure the app-level webhook subscription

In the Meta App Dashboard:

1. Add/configure Webhooks for the app's Lead Ads use case.
2. Select the **Page** object.
3. Enter the production callback URL.
4. Enter the same private verify token configured on the server.
5. Complete the GET verification handshake.
6. Subscribe the app to the Page object's **`leadgen`** field.

This app-level setup defines which callback receives Page `leadgen` notifications. It does not by itself connect every tenant's Facebook Page.

## 8. Subscribe each selected Facebook Page

After a tenant selects a Page in Phase 1, the trusted backend must install the app's webhook subscription on that Page:

```http
POST /{facebook_page_id}/subscribed_apps
subscribed_fields=leadgen
access_token={PAGE_ACCESS_TOKEN}
```

Then verify the result:

```http
GET /{facebook_page_id}/subscribed_apps
access_token={PAGE_ACCESS_TOKEN}
```

Activation rule:

```text
Do not show the Page as ready for automatic lead ingestion
until the POST succeeds and the GET confirms the app/Page subscription.
```

The Page access token is decrypted only inside the trusted server operation. Never accept a Page ID or token from the browser without checking the authenticated tenant's stored Phase 1 mapping.

## 9. POST authenticity verification

For every webhook POST:

1. Read the exact raw request bytes before JSON parsing.
2. Read Meta's signature header defined for webhook payload verification.
3. Calculate the expected HMAC using `META_APP_SECRET` and the raw bytes, following Meta's current webhook security documentation.
4. Compare the supplied and expected signatures using a constant-time comparison.
5. Reject an absent, malformed or mismatched signature with HTTP 403.
6. Only after signature verification, parse the JSON.

The implementation must use the current Meta-documented signature algorithm/header at implementation time. Do not authenticate POST requests using the verify token.

## 10. Payload parsing and batching

Meta can place multiple `entry[]` objects in one POST and multiple `changes[]` objects in each entry. Never implement only `entry[0]` or `changes[0]`.

```text
for every entry in body.entry[]:
    for every change in entry.changes[]:
        if change.field != "leadgen": ignore it
        otherwise validate and persist that change independently
```

For this payload:

```text
changes[0].value.leadgen_id = 123123123123
changes[1].value.leadgen_id = 123123123124
```

the system creates:

```text
Event 1 → Queue job 1 → GET /123123123123 → Lead row 1
Event 2 → Queue job 2 → GET /123123123124 → Lead row 2
```

Canonical rule:

```text
One leadgen changes[] item
= one notification-event row
= one queue job
= one GET /{leadgen_id}
= one lead_data row
```

Each `GET /{leadgen_id}` retrieves the one lead identified by that ID. A single POST may therefore cause two, three or more independent retrieval jobs.

## 11. Payload validation

At minimum, require:

```text
body.object = page
entry is an array
entry.id exists for every processed entry
entry.time is a valid Unix timestamp
change.field = leadgen
change.value is an object
value.leadgen_id exists
value.page_id exists
value.form_id exists
value.created_time is a valid Unix timestamp
```

Treat external Meta identifiers as strings in application code and PostgreSQL even if the JSON example displays numbers. Do not perform arithmetic on them.

`ad_id` and `adgroup_id` remain nullable because a lead may not have usable ad attribution in every documented scenario.

## 12. Tenant resolution

Never read `tenant_id` from the Meta body. Because Phase 1 preserves disconnected Page connections as historical rows, the external Meta Page ID is not a permanent internal relationship key. Resolve the one current non-disconnected Page-connection row whose connection began no later than the lead creation time:

```sql
select
    id,
    tenant_id,
    facebook_page_id,
    connected_at
from public.facebook_pages
where facebook_page_id = :meta_page_id
  and connection_status <> 'disconnected'
  and connected_at <= :lead_created_time;
```

The Phase 1 partial unique index permits a maximum of one matching current row. Map the result as follows:

```text
facebook_pages.id               → event.facebook_page_record_id
facebook_pages.tenant_id        → event.tenant_id
changes[].value.page_id         → event.facebook_page_id
changes[].value.created_time    → event.lead_created_time
```

The `connected_at <= lead_created_time` condition prevents a delayed notification created under an old connection from being routed to a tenant that connected the same Meta Page later.

If the Page is unknown, inactive or requires reauthorization:

- Do not invent a tenant.
- Do not attach the event to another tenant.
- Do not enqueue lead retrieval.
- Record a sanitized operational error/metric outside these two tenant tables.
- Return the webhook response according to the acknowledgement policy so internal details are not exposed.

## 13. Database boundary

Phase 2 uses exactly these core tables:

```text
public.meta_webhook_notification_events
public.lead_data
```

Responsibilities:

| Table | Responsibility |
|---|---|
| `meta_webhook_notification_events` | One normalized row per unique `leadgen` change plus retrieval workflow state |
| `lead_data` | One complete Graph API lead response per `leadgen_id` |

The Page access token remains in the Phase 1 token storage. It must not be duplicated in either Phase 2 table.

## 14. Production schema — notification events

```sql
create table public.meta_webhook_notification_events (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null
        references public.tenants(id)
        on delete cascade,

    facebook_page_record_id uuid not null
        references public.facebook_pages(id)
        on delete restrict,

    facebook_page_id text not null,

    meta_entry_id text not null,
    meta_entry_time timestamptz not null,

    leadgen_id text not null,
    form_id text not null,
    adgroup_id text,
    ad_id text,
    lead_created_time timestamptz not null,

    raw_webhook_change jsonb not null
        check (jsonb_typeof(raw_webhook_change) = 'object'),

    processing_status text not null default 'pending'
        check (
            processing_status in (
                'pending',
                'processing',
                'retry_scheduled',
                'completed',
                'dead_letter'
            )
        ),

    retrieval_attempt_count integer not null default 0
        check (retrieval_attempt_count >= 0),

    queue_dispatched_at timestamptz,
    processing_started_at timestamptz,
    last_retrieval_attempt_at timestamptz,
    next_retrieval_attempt_at timestamptz,
    completed_at timestamptz,

    last_error_code text,
    last_error_message text,

    received_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint meta_webhook_notification_events_leadgen_id_key
        unique (leadgen_id),

    constraint meta_webhook_events_lead_relationship_unique
        unique (
            id,
            tenant_id,
            facebook_page_record_id,
            facebook_page_id,
            leadgen_id
        ),

    constraint meta_webhook_notification_events_completed_check
        check (
            (processing_status = 'completed' and completed_at is not null)
            or
            (processing_status <> 'completed' and completed_at is null)
        )
);
```

`raw_webhook_change` stores the exact individual `changes[]` object, not the access token and not the full lead response.

## 15. Page-connection/tenant database enforcement

The internal Page-record foreign key identifies the exact historical/current connection row. Add database enforcement preventing an event from combining the wrong tenant, Meta Page ID or connection period with that row:

```sql
create or replace function public.validate_webhook_event_page_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    resolved_tenant_id uuid;
    resolved_facebook_page_id text;
    resolved_connected_at timestamptz;
begin
    select
        fp.tenant_id,
        fp.facebook_page_id,
        fp.connected_at
    into
        resolved_tenant_id,
        resolved_facebook_page_id,
        resolved_connected_at
    from public.facebook_pages as fp
    where fp.id = new.facebook_page_record_id;

    if resolved_tenant_id is null then
        raise exception 'Facebook Page connection record not found';
    end if;

    if resolved_tenant_id <> new.tenant_id then
        raise exception 'Facebook Page connection and tenant do not match';
    end if;

    if resolved_facebook_page_id <> new.facebook_page_id then
        raise exception 'Facebook Page IDs do not match';
    end if;

    if resolved_connected_at > new.lead_created_time then
        raise exception 'Lead predates the resolved Facebook Page connection';
    end if;

    return new;
end;
$$;

create trigger validate_webhook_event_page_connection
before insert or update of
    tenant_id,
    facebook_page_record_id,
    facebook_page_id,
    lead_created_time
on public.meta_webhook_notification_events
for each row
execute function public.validate_webhook_event_page_connection();
```

## 16. Event indexes

```sql
create index meta_webhook_events_tenant_id_idx
    on public.meta_webhook_notification_events (tenant_id);

create index meta_webhook_events_page_record_id_idx
    on public.meta_webhook_notification_events (facebook_page_record_id);

create index meta_webhook_events_facebook_page_id_idx
    on public.meta_webhook_notification_events (facebook_page_id);

create index meta_webhook_events_dispatch_recovery_idx
    on public.meta_webhook_notification_events (received_at)
    where processing_status = 'pending'
      and queue_dispatched_at is null;

create index meta_webhook_events_retry_idx
    on public.meta_webhook_notification_events (next_retrieval_attempt_at)
    where processing_status = 'retry_scheduled';

create index meta_webhook_events_processing_recovery_idx
    on public.meta_webhook_notification_events (processing_started_at)
    where processing_status = 'processing';
```

## 17. Idempotent webhook insertion

For each validated `leadgen` change:

```sql
insert into public.meta_webhook_notification_events (...)
values (...)
on conflict (leadgen_id) do nothing
returning id;
```

Rules:

- A returned `id` means a new event was created and needs dispatch.
- No returned row means that `leadgen_id` already exists; do not create another job blindly.
- A duplicate Meta delivery must not create a duplicate event or duplicate lead.
- Deduplication happens independently for each item in `changes[]`.

## 18. Queue design

Use QStash as the delivery mechanism already selected for the CRM. The queue payload must contain only the internal event identifier:

```json
{
  "webhook_notification_event_id": "internal-uuid"
}
```

Do not put Page access tokens, App Secret, verify token or complete lead personal data into the queue message.

For a webhook containing N new `leadgen` changes:

```text
Persist N event rows
→ dispatch N independent queue messages
→ acknowledge the webhook request
```

Queue worker rules:

- Authenticate and verify the QStash request using QStash's supported signing verification.
- Load the event by internal UUID on the server.
- Claim the event atomically so duplicate workers cannot process it simultaneously.
- Process one event/`leadgen_id` per job.
- Failure of one job must not roll back or block other lead jobs from the same webhook POST.
- Initial MVP concurrency may be set to `1` for sequential processing, but this is our operational choice, not a Meta requirement.
- Concurrency can later be increased because different `leadgen_id` jobs are independent.

## 19. Reliable dispatch and recovery

Do not rely on code scheduled to run after returning the webhook response; a serverless runtime may stop that work.

Required order:

```text
Verify POST
→ parse and persist all new event rows
→ attempt queue dispatch for every new event
→ set queue_dispatched_at only after confirmed dispatch
→ return HTTP 200 promptly
```

The database event row acts as the recoverable source of work. A scheduled recovery process must find:

```text
processing_status = pending
and queue_dispatched_at is null
```

and dispatch those events again. This closes the failure gap where the database insert succeeds but the QStash call fails.

Also recover a `processing` event whose `processing_started_at` is older than the configured worker lease timeout. Move it to `retry_scheduled` rather than leaving it stuck forever.

## 20. Atomic job claiming

The worker must claim work with a guarded update:

```sql
update public.meta_webhook_notification_events
set
    processing_status = 'processing',
    processing_started_at = now(),
    last_retrieval_attempt_at = now(),
    retrieval_attempt_count = retrieval_attempt_count + 1
where id = :event_id
  and processing_status in ('pending', 'retry_scheduled')
returning *;
```

If no row is returned, the worker must not call Meta. The event is already completed, dead-lettered or owned by another worker.

## 21. Retrieve the complete lead

Use `facebook_page_record_id` to load the exact Page-connection row and decrypt that row's Page access token. Confirm that its stored `facebook_page_id` equals the event's raw Meta Page ID before calling Graph API:

```http
GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/{leadgen_id}
    ?fields=id,created_time,ad_id,form_id,field_data,custom_disclaimer_responses
    &access_token={PAGE_ACCESS_TOKEN}
```

Requirements:

- Build the request entirely on the trusted server.
- Never accept the access token from the queue or browser.
- Check that the returned `id` equals the event's `leadgen_id`.
- Check that returned identifiers do not contradict the notification before committing.
- Preserve `field_data` as JSON because forms contain variable standard and custom questions.
- Preserve `custom_disclaimer_responses` as nullable JSON.
- Preserve the complete response object as `raw_lead_payload`.

## 22. Production schema — lead data

```sql
create table public.lead_data (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null
        references public.tenants(id)
        on delete cascade,

    webhook_notification_event_id uuid not null,

    leadgen_id text not null,

    facebook_page_record_id uuid not null,
    facebook_page_id text not null,

    form_id text not null,
    ad_id text,
    lead_created_time timestamptz not null,

    field_data jsonb not null
        check (jsonb_typeof(field_data) = 'array'),

    custom_disclaimer_responses jsonb
        check (
            custom_disclaimer_responses is null
            or jsonb_typeof(custom_disclaimer_responses) = 'array'
        ),

    raw_lead_payload jsonb not null
        check (jsonb_typeof(raw_lead_payload) = 'object'),

    retrieved_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint lead_data_notification_event_fk
        foreign key (
            webhook_notification_event_id,
            tenant_id,
            facebook_page_record_id,
            facebook_page_id,
            leadgen_id
        )
        references public.meta_webhook_notification_events (
            id,
            tenant_id,
            facebook_page_record_id,
            facebook_page_id,
            leadgen_id
        )
        on delete restrict,

    constraint lead_data_notification_event_key
        unique (webhook_notification_event_id),

    constraint lead_data_leadgen_id_key
        unique (leadgen_id)
);
```

## 23. Lead indexes

```sql
create index lead_data_tenant_id_idx
    on public.lead_data (tenant_id);

create index lead_data_page_record_id_idx
    on public.lead_data (facebook_page_record_id);

create index lead_data_facebook_page_id_idx
    on public.lead_data (facebook_page_id);

create index lead_data_form_id_idx
    on public.lead_data (form_id);

create index lead_data_ad_id_idx
    on public.lead_data (ad_id)
    where ad_id is not null;

create index lead_data_tenant_created_time_idx
    on public.lead_data (tenant_id, lead_created_time desc);
```

## 24. Successful retrieval transaction

After Meta returns and the response passes validation, perform one database transaction:

```text
BEGIN
→ INSERT lead_data using ON CONFLICT safely
→ UPDATE event to completed
→ set completed_at = now()
→ clear retry time and sanitized error fields
COMMIT
```

If the lead insert fails, roll back the completion update. The event must never say `completed` without its `lead_data` row.

Idempotency rule:

```text
If lead_data already exists for the same leadgen_id and matches the event,
treat the retrieval as already stored and complete the event safely.
```

## 25. Failure classification and retries

Classify failures using the actual HTTP status and Meta Graph error response. Do not guess solely from an error message string.

### Retryable

Examples include temporary network errors, timeouts, rate limits and Meta server failures when the returned error indicates retry is appropriate.

```text
processing_status = retry_scheduled
next_retrieval_attempt_at = calculated backoff time
last_error_code = sanitized code
last_error_message = sanitized message
```

Use capped exponential backoff with jitter. The exact retry count and timing are application policy, not values supplied by Meta; keep them configurable.

### Reauthorization or permanent failure

When Meta's response proves the Page token is invalid/expired or access has been revoked:

- Stop repeated retrieval attempts after the configured policy.
- Mark the Phase 1 Page connection as requiring reauthorization using its existing supported status values.
- Set the event to `dead_letter` when no automated retry can succeed.
- Never copy a token into the error fields.

An unknown/unclassified error must not silently mark the event completed.

## 26. `updated_at` triggers

Reuse the existing Phase 1 `public.set_updated_at()` function:

```sql
create trigger set_meta_webhook_events_updated_at
before update on public.meta_webhook_notification_events
for each row
execute function public.set_updated_at();

create trigger set_lead_data_updated_at
before update on public.lead_data
for each row
execute function public.set_updated_at();
```

## 27. RLS and browser access

```sql
alter table public.meta_webhook_notification_events enable row level security;
alter table public.meta_webhook_notification_events force row level security;

alter table public.lead_data enable row level security;
alter table public.lead_data force row level security;

revoke all on table public.meta_webhook_notification_events
from anon, authenticated;

revoke all on table public.lead_data
from anon, authenticated;
```

Core ingestion and retrieval use the trusted server/service role only. The dashboard must obtain tenant-authorized lead views through a trusted server endpoint that resolves membership and tenant access. Raw webhook events remain operational data and are not exposed to the browser.

## 28. Acknowledgement policy

Return success only after:

- The POST signature is valid.
- The JSON structure is acceptable.
- Every valid new `leadgen` change has been durably persisted, or is confirmed as an existing duplicate.

Lead Graph retrieval does not have to finish before acknowledgement because it is queue-driven. However, never acknowledge first and hope that an unpersisted in-memory task will run later.

Keep the callback response body minimal and never expose tenant, token, database or error details.

## 29. Testing sequence

### Configuration tests

- Valid GET verification returns the exact challenge.
- Wrong verify token returns 403.
- Missing verification parameters fail.
- App is configured for Page object and `leadgen` field.
- Each selected Page is subscribed through `/{PAGE_ID}/subscribed_apps`.
- GET `/{PAGE_ID}/subscribed_apps` confirms the subscription.

### Security tests

- Valid signed POST is accepted.
- Missing signature is rejected.
- Modified raw body with the old signature is rejected.
- App Secret, verify token and Page token never appear in logs, queue payloads or database error fields.
- Browser roles cannot read/write either core table directly.

### Batch tests

- One entry and one change creates one event and one job.
- One entry with two leadgen changes creates two event rows and two jobs.
- Multiple entries and multiple changes are all processed.
- A non-`leadgen` change is ignored.
- Duplicate `leadgen_id` does not create another event, job or lead.
- Failure of job 2 does not undo successful jobs 1 and 3.

### Tenant tests

- Known Page resolves the correct tenant.
- Unknown Page is never assigned to a tenant.
- The same external Meta Page ID may exist in multiple disconnected historical rows.
- Only the one non-disconnected Page row can resolve for new webhook routing.
- A delayed lead whose `lead_created_time` predates the current Page row's `connected_at` is not routed to the new tenant.
- Page-record/tenant mismatch is rejected by the database trigger.
- Page-record/external-Page-ID mismatch is rejected by the database trigger.
- Lead creation time predating the selected Page connection is rejected by the database trigger.
- A job cannot retrieve a token belonging to another Page/tenant.

### Retrieval tests

- Valid `GET /{leadgen_id}` stores one lead.
- Standard and custom questions remain intact in `field_data`.
- Disclaimer responses present and absent both work.
- Nullable ad attribution works.
- Response ID mismatch is rejected.
- Lead insert and event completion commit atomically.
- Duplicate queue delivery remains idempotent.
- Temporary Meta failure schedules a retry.
- Invalid/revoked token triggers the existing reauthorization flow.
- Persisted-but-not-dispatched event is recovered.
- Stuck `processing` event is recovered after the worker lease expires.

Use Meta's Lead Ads testing tools/test-lead endpoints for the real end-to-end test. A synthetic webhook test alone is not proof that the returned `leadgen_id` can be retrieved successfully.

## 30. Deployment order

```text
1. Apply both Phase 2 tables, constraints, indexes, triggers and RLS.
2. Configure secrets and a pinned supported Graph API version.
3. Deploy GET/POST callback endpoint.
4. Complete callback verification.
5. Configure Page object → leadgen at app level.
6. Implement Page subscription and confirmation during Page activation.
7. Deploy QStash worker and request verification.
8. Deploy pending/stuck-event recovery process.
9. Run batch, duplicate, failure and tenant-isolation tests.
10. Run Meta test-lead end-to-end verification.
11. Confirm App Review/access requirements before real tenant production traffic.
12. Enable production monitoring and alerts.
```

## 31. Final production flow

```text
Tenant selects a Facebook Page
→ backend subscribes Page to app with subscribed_fields=leadgen
→ backend confirms Page subscription

User submits Meta lead form
→ Meta sends one signed POST
→ callback verifies signature on raw bytes
→ callback loops through every entry[] and every changes[]
→ callback resolves the one current Page row valid at lead_created_time
→ each unique leadgen change becomes one database event
→ each new event becomes one QStash job
→ callback returns success after durable persistence/dispatch attempt
→ worker claims exactly one event
→ worker loads facebook_page_record_id and decrypts that exact Page row's token
→ worker calls GET /{leadgen_id}
→ transaction inserts one lead_data row
→ transaction marks that event completed
→ failed events retry independently
```

## 32. Final decision

The original database core was directionally correct, but the earlier document was incomplete as a full Phase 2 plan because it began after webhook delivery. This final plan adds the missing production lifecycle:

```text
callback verification
+ app-level Page/leadgen configuration
+ per-Page subscribed_apps installation and confirmation
+ POST authenticity verification
+ full batch iteration
+ one queue job per leadgen_id
+ reliable dispatch recovery
+ idempotent retrieval and storage
+ retry/dead-letter handling
+ tenant isolation and production tests
```

This is the implementation boundary for Phase 2. Phase 1 connection/token ownership remains unchanged.

### Phase 1 historical-Page compatibility modification

Phase 2 no longer uses the external Meta Page ID as a direct foreign key:

```text
Before:
facebook_page_id → facebook_pages.facebook_page_id

After:
facebook_page_record_id → facebook_pages.id
facebook_page_id → raw Meta payload value stored as text
```

`lead_data` references the exact webhook event using the event ID, tenant ID, Page-record UUID, Meta Page ID and leadgen ID. Old Tenant A events can therefore retain `record-A`, while later Tenant B events for the same external Meta Page ID retain `record-B`.
