-- Run with scripts/test-meta-migration.ps1, which creates an isolated PostgreSQL cluster.
-- Kept outside supabase/tests so Supabase's pgTAP runner does not treat it as TAP.
begin;

create function pg_temp.assert_true(p_condition boolean, p_message text) returns void
language plpgsql as $$
begin
    if p_condition is distinct from true then
        raise exception 'Assertion failed: %', p_message;
    end if;
end;
$$;

create function pg_temp.expect_error(p_sql text, p_state text) returns void
language plpgsql as $$
begin
    begin
        execute p_sql;
    exception when others then
        if sqlstate = p_state then return; end if;
        raise exception 'Expected SQLSTATE %, got %: %', p_state, sqlstate, sqlerrm;
    end;
    raise exception 'Expected SQLSTATE %, but statement succeeded', p_state;
end;
$$;

insert into public.tenants (tenant_id, tenant_name) values
('10000000-0000-0000-0000-000000000001', 'Test Tenant A'),
('10000000-0000-0000-0000-000000000002', 'Test Tenant B');
insert into public.meta_connections (id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted) values
('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'meta-a', 'test-ciphertext'),
('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'meta-b', 'test-ciphertext'),
('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'meta-a-2', 'test-ciphertext');

create function pg_temp.page_payload(p_id text default 'page-1') returns jsonb
language sql as $$
    select jsonb_build_object(
        'facebook_page_id', p_id, 'facebook_page_name', 'Test Page',
        'page_access_token_encrypted', 'test-ciphertext', 'assigned_tasks', jsonb_build_array('ADVERTISE'),
        'token_expires_at', now() + interval '1 day', 'last_verified_at', now()
    )
$$;

-- These security-invoker helpers execute the real RPC with the current test role.
create function pg_temp.connect_a(p_pages jsonb) returns void language sql as $$
    select public.connect_selected_facebook_pages(
        '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', p_pages
    )
$$;

-- Check every table privilege, including DELETE inherited from permissive defaults.
do $$
declare v_table text; v_role text; v_privilege text;
begin
    foreach v_table in array array['meta_connections', 'facebook_pages'] loop
        foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
            foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
                perform pg_temp.assert_true(
                    has_table_privilege(v_role, 'public.' || v_table, v_privilege)
                    = (v_role = 'service_role' and v_privilege in ('SELECT', 'INSERT', 'UPDATE')),
                    format('%s %s %s ACL', v_role, v_table, v_privilege)
                );
            end loop;
        end loop;
        perform pg_temp.assert_true(
            (select relrowsecurity from pg_class where oid = ('public.' || v_table)::regclass), v_table || ' RLS enabled'
        );
        perform pg_temp.assert_true(
            not exists (select 1 from pg_class c, lateral aclexplode(c.relacl) a
                where c.oid = ('public.' || v_table)::regclass and a.grantee = 0), v_table || ' PUBLIC revoked'
        );
    end loop;
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
        perform pg_temp.assert_true(has_function_privilege(v_role,
            'public.connect_selected_facebook_pages(uuid,uuid,jsonb)', 'EXECUTE') = (v_role = 'service_role'), v_role || ' connect RPC');
        perform pg_temp.assert_true(has_function_privilege(v_role,
            'public.disconnect_meta_connection(uuid,uuid)', 'EXECUTE') = (v_role = 'service_role'), v_role || ' disconnect RPC');
    end loop;
end;
$$;

set local role service_role;
do $$
declare v_input jsonb; v_field text; v_value jsonb;
begin
    foreach v_input in array array[null::jsonb, 'null', '{}', '"text"', '1', 'true', '[]'] loop
        perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', v_input), '22023');
    end loop;
    foreach v_input in array array['[null]'::jsonb, '[1]', '[[]]', '["page"]'] loop
        perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', v_input), '22023');
    end loop;
    foreach v_field in array array['facebook_page_id', 'facebook_page_name', 'page_access_token_encrypted'] loop
        foreach v_value in array array['null'::jsonb, '""', '"   "', '"\t\n"', '1', 'true', '[]', '{}'] loop
            v_input := jsonb_build_array(pg_temp.page_payload() || jsonb_build_object(v_field, v_value));
            perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', v_input), '22023');
        end loop;
        perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', jsonb_build_array(pg_temp.page_payload() - v_field)), '22023');
    end loop;
    foreach v_value in array array['null'::jsonb, '{}', '"ADVERTISE"', '[1]', '[true]', '[null]', '[{}]', '[[]]', '["ADVERTISE",1]'] loop
        v_input := jsonb_build_array(pg_temp.page_payload() || jsonb_build_object('assigned_tasks', v_value));
        perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', v_input), '22023');
    end loop;
    foreach v_field in array array['assigned_tasks', 'token_expires_at', 'last_verified_at'] loop
        perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', jsonb_build_array(pg_temp.page_payload() - v_field)), '22023');
    end loop;
    foreach v_field in array array['token_expires_at', 'last_verified_at'] loop
        foreach v_value in array array['1'::jsonb, '""', '"invalid"', '"infinity"', '"-infinity"', '"2026-99-99"'] loop
            v_input := jsonb_build_array(pg_temp.page_payload() || jsonb_build_object(v_field, v_value));
            perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', v_input), '22023');
        end loop;
    end loop;
    perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', jsonb_build_array(
        pg_temp.page_payload() || jsonb_build_object('last_verified_at', null))), '22023');
    perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', jsonb_build_array(
        pg_temp.page_payload() || jsonb_build_object('token_expires_at', now() - interval '1 second'))), '22023');
    perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', jsonb_build_array(
        pg_temp.page_payload() || jsonb_build_object('last_verified_at', now() + interval '1 day'))), '22023');
    perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', jsonb_build_array(
        pg_temp.page_payload('valid-first'), pg_temp.page_payload('invalid-second') - 'assigned_tasks')), '22023');
    perform pg_temp.assert_true((select count(*) = 0 from public.facebook_pages), 'invalid inputs write no Pages');
end;
$$;

select pg_temp.connect_a(jsonb_build_array(pg_temp.page_payload()));
do $$
declare v_id uuid; v_expiry timestamptz;
begin
    select id, token_expires_at into v_id, v_expiry from public.facebook_pages where facebook_page_id = 'page-1';
    perform pg_temp.assert_true(v_expiry = now() + interval '1 day', 'insert preserves expiry');
    perform pg_temp.assert_true((select last_verified_at = now() and token_status = 'active' from public.facebook_pages where id = v_id), 'insert preserves verification time');

    perform pg_temp.expect_error(format(
        'select public.connect_selected_facebook_pages(%L,%L,%L::jsonb)',
        '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.page_payload('new-before-conflict'), pg_temp.page_payload())
    ), 'P0001');
    perform pg_temp.assert_true((select count(*) = 1 from public.facebook_pages), 'cross-tenant conflict rolls back entire batch');
    perform pg_temp.expect_error(format(
        'select public.connect_selected_facebook_pages(%L,%L,%L::jsonb)',
        '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', jsonb_build_array(pg_temp.page_payload())
    ), 'P0002');
    perform pg_temp.expect_error($q$update public.facebook_pages set meta_connection_id = '20000000-0000-0000-0000-000000000002'$q$, '23503');
    perform pg_temp.expect_error($q$insert into public.facebook_pages (tenant_id,meta_connection_id,facebook_page_id,facebook_page_name,page_access_token_encrypted)
        values ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','page-1','Duplicate','ciphertext')$q$, '23505');

    perform pg_temp.connect_a(jsonb_build_array(pg_temp.page_payload() || jsonb_build_object('token_expires_at', now() + interval '2 days')));
    perform pg_temp.assert_true((select id = v_id and token_expires_at = now() + interval '2 days' from public.facebook_pages where facebook_page_id = 'page-1'), 'active reconnect preserves ID and updates expiry');
    perform pg_temp.expect_error($q$select public.disconnect_meta_connection('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001')$q$, 'P0002');
    perform public.disconnect_meta_connection('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
    perform pg_temp.assert_true((select connection_status = 'disconnected' and token_status = 'invalid' and disconnected_at is not null from public.facebook_pages where id = v_id), 'disconnect invalidates Page');
    perform pg_temp.assert_true((select connection_status = 'disconnected' and user_token_status = 'invalid' and disconnected_at is not null from public.meta_connections where id = '20000000-0000-0000-0000-000000000001'), 'disconnect invalidates connection');
    perform pg_temp.expect_error(format('select pg_temp.connect_a(%L::jsonb)', jsonb_build_array(pg_temp.page_payload())), 'P0002');

    perform public.connect_selected_facebook_pages('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003',
        jsonb_build_array(pg_temp.page_payload() || jsonb_build_object('token_expires_at', now() + interval '3 days', 'assigned_tasks', '[]'::jsonb)));
    perform pg_temp.assert_true((select id = v_id and token_expires_at = now() + interval '3 days' and cardinality(assigned_tasks) = 0
        and connection_status = 'active' and token_status = 'active' and disconnected_at is null from public.facebook_pages where facebook_page_id = 'page-1'), 'historical reconnect preserves ID and actual expiry');
    perform public.connect_selected_facebook_pages('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003',
        jsonb_build_array(pg_temp.page_payload() || jsonb_build_object('token_expires_at', null)));
    perform pg_temp.assert_true((select id = v_id and token_expires_at is null from public.facebook_pages where facebook_page_id = 'page-1'), 'verified no-expiry replaces previous expiry');
    perform public.disconnect_meta_connection('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003');
    perform public.connect_selected_facebook_pages('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.page_payload()));
    perform pg_temp.assert_true((select count(*) = 2 from public.facebook_pages where facebook_page_id = 'page-1'), 'disconnected Page can move tenants while retaining history');
    perform public.connect_selected_facebook_pages('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.page_payload('page-no-expiry') || jsonb_build_object('token_expires_at', null)));
    perform pg_temp.assert_true((select token_expires_at is null and token_status = 'active' from public.facebook_pages where facebook_page_id = 'page-no-expiry'), 'insert accepts verified no-expiry');
    perform pg_temp.expect_error('delete from public.facebook_pages', '42501');
    perform pg_temp.expect_error('delete from public.meta_connections', '42501');
end;
$$;

set local role anon;
select pg_temp.expect_error('select * from public.facebook_pages', '42501');
select pg_temp.expect_error('select * from public.meta_connections', '42501');
select pg_temp.expect_error($$select public.connect_selected_facebook_pages(null,null,'[]')$$, '42501');
select pg_temp.expect_error('select public.disconnect_meta_connection(null,null)', '42501');
set local role authenticated;
select pg_temp.expect_error('select * from public.facebook_pages', '42501');
select pg_temp.expect_error('select * from public.meta_connections', '42501');
select pg_temp.expect_error($$select public.connect_selected_facebook_pages(null,null,'[]')$$, '42501');
select pg_temp.expect_error('select public.disconnect_meta_connection(null,null)', '42501');
reset role;

select 'PASS: validation, expiry, tenant conflicts, atomic rollback, reconnect/disconnect, RLS and privileges' as result;
rollback;
