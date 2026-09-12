-- Facebook Login callbacks: de-authorization and data deletion.
--
-- Meta pings the de-authorize callback whenever someone removes the app from facebook.com without ever
-- touching this CRM ("People are able to uninstall apps via Facebook.com without interacting with the app
-- itself. To help apps detect when this has happened, we allow them to provide a de-authorize callback
-- URL which will be pinged whenever this occurs."). Until now that was invisible here, so a removed app
-- left connections marked active and leads silently stopped arriving.
--
-- The data-deletion callback is a separate, mandatory endpoint that must return a status URL and a
-- confirmation code, so the request needs a durable record to look that status up against.
begin;

create table public.meta_data_deletion_requests (
    id uuid primary key default gen_random_uuid(),
    confirmation_code text not null unique,
    meta_user_id text not null,
    status text not null default 'completed' check (status in ('received', 'completed')),
    connections_disconnected integer not null default 0,
    requested_at timestamptz not null default now(),
    completed_at timestamptz
);

create index meta_data_deletion_requests_meta_user_id_idx on public.meta_data_deletion_requests (meta_user_id);

alter table public.meta_data_deletion_requests enable row level security;
revoke all on table public.meta_data_deletion_requests from public, anon, authenticated, service_role;
grant select, insert on table public.meta_data_deletion_requests to service_role;

-- Disconnects every live connection for one Facebook user, across every tenant, and scrubs the stored
-- tokens. Deliberately not tenant-scoped: the person removed the app from their Facebook account, so no
-- tenant's copy of that authorization is valid any more. Returns the number of connections affected.
create or replace function public.deauthorize_meta_user(p_meta_user_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_disconnected integer;
begin
    with affected as (
        update public.meta_connections set
            connection_status = 'disconnected',
            user_token_status = 'invalid',
            long_lived_user_access_token_encrypted = null,
            disconnected_at = now()
        where meta_user_id = p_meta_user_id and connection_status <> 'disconnected'
        returning id
    )
    select count(*) into v_disconnected from affected;

    update public.facebook_pages set
        connection_status = 'disconnected',
        token_status = 'invalid',
        page_access_token_encrypted = null,
        disconnected_at = now()
    where connection_status <> 'disconnected'
      and meta_connection_id in (
        select id from public.meta_connections where meta_user_id = p_meta_user_id
      );

    return v_disconnected;
end;
$$;

revoke all on function public.deauthorize_meta_user(text) from public, anon, authenticated;
grant execute on function public.deauthorize_meta_user(text) to service_role;

commit;
