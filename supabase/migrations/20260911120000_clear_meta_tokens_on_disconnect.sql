-- Disconnecting must delete stored Meta tokens, not only mark them invalid.
-- Deploy together with the connection-service change that clears page_access_token_encrypted on Page disconnect;
-- that code fails the NOT NULL constraint until this migration is applied.
begin;

alter table public.meta_connections alter column long_lived_user_access_token_encrypted drop not null;
alter table public.facebook_pages alter column page_access_token_encrypted drop not null;

-- Scrub tokens left behind by earlier disconnects.
update public.meta_connections set long_lived_user_access_token_encrypted = null
where connection_status = 'disconnected' and long_lived_user_access_token_encrypted is not null;
update public.facebook_pages set page_access_token_encrypted = null
where connection_status = 'disconnected' and page_access_token_encrypted is not null;

-- Only disconnected rows may be without a token.
alter table public.meta_connections add constraint meta_connections_token_present_check
    check (connection_status = 'disconnected' or long_lived_user_access_token_encrypted is not null);
alter table public.facebook_pages add constraint facebook_pages_token_present_check
    check (connection_status = 'disconnected' or page_access_token_encrypted is not null);

create or replace function public.disconnect_meta_connection(p_tenant_id uuid, p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.meta_connections set connection_status = 'disconnected', user_token_status = 'invalid',
        long_lived_user_access_token_encrypted = null, disconnected_at = now()
    where id = p_connection_id and tenant_id = p_tenant_id and connection_status <> 'disconnected';
    if not found then
        raise exception 'Connection was not found' using errcode = 'P0002';
    end if;
    update public.facebook_pages set connection_status = 'disconnected', token_status = 'invalid',
        page_access_token_encrypted = null, disconnected_at = now()
    where meta_connection_id = p_connection_id and tenant_id = p_tenant_id and connection_status <> 'disconnected';
end;
$$;

commit;
