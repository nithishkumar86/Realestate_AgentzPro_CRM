create extension if not exists pgcrypto;

create table public.meta_connections (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants(id) on delete cascade,
    connected_by_user_id uuid references auth.users(id) on delete set null,
    meta_user_id text not null,
    granted_permissions text[] not null default '{}'::text[],
    long_lived_user_access_token_encrypted text not null,
    user_token_expires_at timestamptz,
    data_access_expires_at timestamptz,
    user_token_status text not null default 'active' check (user_token_status in ('active', 'invalid', 'expired', 'reauthorization_required')),
    connection_status text not null default 'active' check (connection_status in ('active', 'reauthorization_required', 'disconnected')),
    connected_at timestamptz not null default now(),
    last_verified_at timestamptz,
    disconnected_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint meta_connections_tenant_meta_user_unique unique (tenant_id, meta_user_id),
    constraint meta_connections_id_tenant_unique unique (id, tenant_id),
    constraint meta_connections_disconnected_at_check check ((connection_status = 'disconnected' and disconnected_at is not null) or (connection_status <> 'disconnected' and disconnected_at is null))
);

create table public.facebook_pages (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants(id) on delete cascade,
    meta_connection_id uuid not null,
    facebook_page_id text not null,
    facebook_page_name text not null,
    assigned_tasks text[] not null default '{}'::text[],
    page_access_token_encrypted text not null,
    token_expires_at timestamptz,
    token_status text not null default 'active' check (token_status in ('active', 'invalid', 'expired', 'reauthorization_required')),
    connection_status text not null default 'active' check (connection_status in ('active', 'reauthorization_required', 'disconnected')),
    connected_at timestamptz not null default now(),
    last_verified_at timestamptz,
    disconnected_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint facebook_pages_connection_tenant_fk foreign key (meta_connection_id, tenant_id) references public.meta_connections(id, tenant_id) on delete cascade,
    constraint facebook_pages_disconnected_at_check check ((connection_status = 'disconnected' and disconnected_at is not null) or (connection_status <> 'disconnected' and disconnected_at is null))
);

create index meta_connections_connected_by_user_id_idx on public.meta_connections (connected_by_user_id);
create index meta_connections_user_token_status_idx on public.meta_connections (user_token_status);
create index facebook_pages_tenant_id_idx on public.facebook_pages (tenant_id);
create index facebook_pages_meta_connection_id_idx on public.facebook_pages (meta_connection_id);
create index facebook_pages_token_status_idx on public.facebook_pages (token_status);
create unique index facebook_pages_active_page_id_unique on public.facebook_pages (facebook_page_id) where connection_status <> 'disconnected';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create trigger set_meta_connections_updated_at before update on public.meta_connections for each row execute function public.set_updated_at();
create trigger set_facebook_pages_updated_at before update on public.facebook_pages for each row execute function public.set_updated_at();

alter table public.meta_connections enable row level security;
alter table public.facebook_pages enable row level security;
revoke all on table public.meta_connections from anon, authenticated;
revoke all on table public.facebook_pages from anon, authenticated;
grant select, insert, update on table public.meta_connections to service_role;
grant select, insert, update on table public.facebook_pages to service_role;

create or replace function public.connect_selected_facebook_pages(
    p_tenant_id uuid,
    p_connection_id uuid,
    p_pages jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_page jsonb;
    v_existing public.facebook_pages%rowtype;
    v_history_id uuid;
begin
    if jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) = 0 then
        raise exception 'At least one Page must be selected' using errcode = '22023';
    end if;

    perform 1 from public.meta_connections
    where id = p_connection_id and tenant_id = p_tenant_id and connection_status <> 'disconnected'
    for update;
    if not found then
        raise exception 'Connection was not found' using errcode = 'P0002';
    end if;

    for v_page in
        select value from jsonb_array_elements(p_pages) as page(value)
        order by value->>'facebook_page_id'
    loop
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_page->>'facebook_page_id', 0));
        select * into v_existing from public.facebook_pages
        where facebook_page_id = v_page->>'facebook_page_id' and connection_status <> 'disconnected'
        for update;

        if found and v_existing.tenant_id <> p_tenant_id then
            raise exception 'Page is already connected to another CRM account' using errcode = 'P0001';
        end if;

        if found then
            update public.facebook_pages set
                meta_connection_id = p_connection_id,
                facebook_page_name = v_page->>'facebook_page_name',
                assigned_tasks = array(select jsonb_array_elements_text(v_page->'assigned_tasks')),
                page_access_token_encrypted = v_page->>'page_access_token_encrypted',
                token_expires_at = null,
                token_status = 'active',
                connection_status = 'active',
                connected_at = now(),
                last_verified_at = now(),
                disconnected_at = null
            where id = v_existing.id;
        else
            select id into v_history_id from public.facebook_pages
            where tenant_id = p_tenant_id and facebook_page_id = v_page->>'facebook_page_id' and connection_status = 'disconnected'
            order by updated_at desc limit 1 for update;

            if v_history_id is not null then
                update public.facebook_pages set
                    meta_connection_id = p_connection_id,
                    facebook_page_name = v_page->>'facebook_page_name',
                    assigned_tasks = array(select jsonb_array_elements_text(v_page->'assigned_tasks')),
                    page_access_token_encrypted = v_page->>'page_access_token_encrypted',
                    token_expires_at = null,
                    token_status = 'active',
                    connection_status = 'active',
                    connected_at = now(),
                    last_verified_at = now(),
                    disconnected_at = null
                where id = v_history_id;
            else
                insert into public.facebook_pages (
                    tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, assigned_tasks,
                    page_access_token_encrypted, token_status, connection_status, last_verified_at
                ) values (
                    p_tenant_id, p_connection_id, v_page->>'facebook_page_id', v_page->>'facebook_page_name',
                    array(select jsonb_array_elements_text(v_page->'assigned_tasks')),
                    v_page->>'page_access_token_encrypted', 'active', 'active', now()
                );
            end if;
        end if;
    end loop;
end;
$$;

create or replace function public.disconnect_meta_connection(p_tenant_id uuid, p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.meta_connections set connection_status = 'disconnected', user_token_status = 'invalid', disconnected_at = now()
    where id = p_connection_id and tenant_id = p_tenant_id and connection_status <> 'disconnected';
    if not found then
        raise exception 'Connection was not found' using errcode = 'P0002';
    end if;
    update public.facebook_pages set connection_status = 'disconnected', token_status = 'invalid', disconnected_at = now()
    where meta_connection_id = p_connection_id and tenant_id = p_tenant_id and connection_status <> 'disconnected';
end;
$$;

revoke all on function public.connect_selected_facebook_pages(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.disconnect_meta_connection(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connect_selected_facebook_pages(uuid, uuid, jsonb) to service_role;
grant execute on function public.disconnect_meta_connection(uuid, uuid) to service_role;
