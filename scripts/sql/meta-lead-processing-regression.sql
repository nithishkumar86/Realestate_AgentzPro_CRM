-- Deterministic race interleavings against real PostgreSQL functions.
begin;
set local statement_timeout = '30s';
create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %', message; end if; end;
$$;
insert into public.tenants(tenant_id, tenant_name) values ('10000000-0000-0000-0000-000000000001', 'Regression');
insert into public.meta_connections(id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted)
values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'user', 'fixture');
insert into public.facebook_pages(id, tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, page_access_token_encrypted, connected_at)
values ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'page', 'Page', 'fixture', now() - interval '1 day');
create function pg_temp.new_event() returns uuid language plpgsql as $$
declare result uuid;
begin
 insert into public.meta_webhook_notification_events(tenant_id, facebook_page_record_id, facebook_page_id,
 meta_entry_id, meta_entry_time, leadgen_id, form_id, lead_created_time, raw_webhook_change)
 values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'page', 'entry', now(), gen_random_uuid()::text, 'form', now(), '{}') returning id into result;
 return result;
end;
$$;

do $$
declare eid uuid; a public.meta_webhook_notification_events; b public.meta_webhook_notification_events; first_mapping public.meta_ads; second_mapping public.meta_ads; generation uuid; duplicate_leadgen text; failed boolean;
begin
 eid := pg_temp.new_event();
 select * into a from public.claim_meta_webhook_notification_event(eid);
 perform pg_temp.assert_true(a.claim_token is not null, 'claim issues ownership');
 select * into b from public.claim_meta_webhook_notification_event(eid);
 perform pg_temp.assert_true(b.id is null, 'duplicate delivery cannot claim processing event');
 update public.meta_webhook_notification_events set processing_started_at = now() - interval '11 minutes' where id = eid;
 perform pg_temp.assert_true(not public.complete_meta_lead_retrieval_event(eid,a.claim_token,'[]',null,'{}',now(),null), 'expired worker rejected before recovery');
 perform * from public.recover_meta_webhook_notification_events();
 select * into b from public.claim_meta_webhook_notification_event(eid);
 perform pg_temp.assert_true(b.claim_token <> a.claim_token, 'reclaim rotates ownership');
 perform pg_temp.assert_true(not public.complete_meta_lead_retrieval_event(eid,a.claim_token,'[]',null,'{}',now(),null), 'old worker cannot complete new claim');
 perform pg_temp.assert_true(not public.schedule_meta_lead_retrieval_retry(eid,a.claim_token,now(),'old','old',null,true,true), 'old worker cannot fail new claim');
 perform pg_temp.assert_true((select claim_token = b.claim_token from public.meta_webhook_notification_events where id=eid), 'new owner unchanged');
 insert into public.meta_ads(tenant_id,ad_id,source_facebook_page_record_id,ad_name,resolution_status,next_retry_at,last_resolved_at)
 values (b.tenant_id,'retrieved-ad',b.facebook_page_record_id,'Retrieved Ad','resolved',null,now());
 perform pg_temp.assert_true(public.complete_meta_lead_retrieval_event(eid,b.claim_token,'[]',null,'{}',now(),'retrieved-ad'), 'current worker completes');
 perform pg_temp.assert_true((select ad_id='retrieved-ad' and ad_name='Retrieved Ad' from public.lead_data where webhook_notification_event_id=eid), 'retrieved ad fallback uses cached name');
 perform pg_temp.assert_true((select ad_id='retrieved-ad' from public.meta_webhook_notification_events where id=eid), 'fallback persists to event');
 perform pg_temp.assert_true(not public.complete_meta_lead_retrieval_event(eid,b.claim_token,'[]',null,'{}',now(),'retrieved-ad'), 'completion replay harmless');

 eid := pg_temp.new_event();
 update public.meta_webhook_notification_events set retrieval_attempt_count=5 where id=eid;
 select * into a from public.claim_meta_webhook_notification_event(eid);
 update public.meta_webhook_notification_events set processing_started_at=now()-interval '11 minutes' where id=eid;
 perform * from public.recover_meta_webhook_notification_events();
 perform pg_temp.assert_true((select processing_status='dead_letter' and claim_token is null and next_retrieval_attempt_at is null from public.meta_webhook_notification_events where id=eid), 'sixth timeout terminates');
 perform pg_temp.assert_true(not exists(select 1 from public.recover_meta_webhook_notification_events() r where r.id=eid), 'exhausted event never redispatched');

 eid := pg_temp.new_event();
 select * into a from public.claim_meta_webhook_notification_event(eid);
 failed := false;
 begin perform public.schedule_meta_lead_retrieval_retry(eid,a.claim_token,null,'retry','retry',null);
 exception when invalid_parameter_value then failed := true; end;
 perform pg_temp.assert_true(failed, 'NULL retry rejected');
 perform pg_temp.assert_true((select claim_token=a.claim_token from public.meta_webhook_notification_events where id=eid), 'invalid retry leaves claim intact');
 perform public.schedule_meta_lead_retrieval_retry(eid,a.claim_token,now(),'retry','retry',null);
 perform pg_temp.assert_true(not public.mark_meta_webhook_event_dispatched(eid,a.dispatch_generation), 'late original dispatch rejected');
 select dispatch_generation into generation from public.meta_webhook_notification_events where id=eid;
 perform pg_temp.assert_true(exists(select 1 from public.recover_meta_webhook_notification_events() r where r.id=eid and r.dispatch_generation=generation), 'new retry remains recoverable');
 perform pg_temp.assert_true(public.mark_meta_webhook_event_dispatched(eid,generation), 'current acknowledgement accepted');
 select * into b from public.claim_meta_webhook_notification_event(eid);
 perform pg_temp.assert_true(b.id=eid, 'acknowledged retry can execute');
 perform public.schedule_meta_lead_retrieval_retry(eid,b.claim_token,now(),'retry','retry',null);
 perform pg_temp.assert_true(not public.mark_meta_webhook_event_dispatched(eid,generation), 'late recovery dispatch rejected');
 failed := false;
 begin update public.meta_webhook_notification_events set next_retrieval_attempt_at=null where id=eid;
 exception when check_violation then failed:=true; end;
 perform pg_temp.assert_true(failed, 'direct NULL retry blocked by constraint');

 eid := pg_temp.new_event();
 select * into a from public.claim_meta_webhook_notification_event(eid);
 select connection_generation into generation from public.facebook_pages where id=a.facebook_page_record_id;
 update public.facebook_pages set connection_status='disconnected',disconnected_at=now(),token_status='invalid' where id=a.facebook_page_record_id;
 perform pg_temp.assert_true(public.schedule_meta_lead_retrieval_retry(eid,a.claim_token,null,'auth','auth',generation,true,true), 'disconnected failure records without rollback');
 perform pg_temp.assert_true((select connection_status='disconnected' from public.facebook_pages where id=a.facebook_page_record_id), 'disconnect preserved');
 update public.facebook_pages set connection_status='active',disconnected_at=null,token_status='active' where id=a.facebook_page_record_id;

 eid := pg_temp.new_event();
 select * into a from public.claim_meta_webhook_notification_event(eid);
 select connection_generation into generation from public.facebook_pages where id=a.facebook_page_record_id;
 perform public.connect_selected_facebook_pages(a.tenant_id,'20000000-0000-0000-0000-000000000001',
 jsonb_build_array(jsonb_build_object('facebook_page_id','page','facebook_page_name','Page','page_access_token_encrypted','replacement',
 'assigned_tasks',jsonb_build_array('ADVERTISE'),'token_expires_at',now()+interval '1 day','last_verified_at',now())));
 perform pg_temp.assert_true((select connection_generation <> generation from public.facebook_pages where id=a.facebook_page_record_id), 'actual reconnect rotates generation');
 perform public.schedule_meta_lead_retrieval_retry(eid,a.claim_token,now(),'auth','auth',generation,true,true);
 perform pg_temp.assert_true((select connection_status='active' and token_status='active' from public.facebook_pages where id=a.facebook_page_record_id), 'stale token failure preserves renewed page');
 perform pg_temp.assert_true((select processing_status='retry_scheduled' from public.meta_webhook_notification_events where id=eid), 'stale authorization failure retries current token');
 select * into b from public.claim_meta_webhook_notification_event(eid);
 select connection_generation into generation from public.facebook_pages where id=b.facebook_page_record_id;
 perform public.schedule_meta_lead_retrieval_retry(eid,b.claim_token,null,'auth','auth',generation,true,true);
 perform pg_temp.assert_true((select connection_status='reauthorization_required' from public.facebook_pages where id=b.facebook_page_record_id), 'current token failure invalidates page');

 perform pg_temp.assert_true(to_regprocedure('public.complete_meta_lead_retrieval_event(uuid,jsonb,jsonb,jsonb,timestamptz)') is null, 'unsafe completion removed');
 perform pg_temp.assert_true(not has_function_privilege('authenticated','public.complete_meta_lead_retrieval_event(uuid,uuid,jsonb,jsonb,jsonb,timestamptz,text)','EXECUTE'), 'customer cannot invoke completion');
 perform pg_temp.assert_true(has_function_privilege('service_role','public.complete_meta_lead_retrieval_event(uuid,uuid,jsonb,jsonb,jsonb,timestamptz,text)','EXECUTE'), 'worker can invoke completion');
 perform pg_temp.assert_true(not has_function_privilege('anon','public.claim_due_meta_ad_name_resolution()','EXECUTE'), 'anon cannot claim ad resolution');
 perform pg_temp.assert_true(not has_function_privilege('authenticated','public.claim_due_meta_ad_name_resolution()','EXECUTE'), 'authenticated cannot claim ad resolution');
 perform pg_temp.assert_true(not has_function_privilege('authenticated','public.complete_meta_ad_name_resolution(uuid,text,uuid,text)','EXECUTE'), 'customer cannot complete ad resolution');
 perform pg_temp.assert_true(not has_function_privilege('authenticated','public.schedule_meta_ad_name_resolution_retry(uuid,text,uuid,text,timestamptz,text,text)','EXECUTE'), 'customer cannot schedule ad retry');
 perform pg_temp.assert_true(not has_function_privilege('authenticated','public.recover_meta_ad_name_resolutions()','EXECUTE'), 'customer cannot recover ad resolution');
 perform pg_temp.assert_true(has_function_privilege('service_role','public.recover_meta_ad_name_resolutions()','EXECUTE'), 'worker can recover ad resolution');
 perform pg_temp.assert_true(not has_table_privilege('authenticated','public.meta_ads','SELECT'), 'customer cannot read ad cache directly');

 -- Resolver claims are exclusive, recoverable after lease expiry, and reject stale workers.
 insert into public.meta_ads(tenant_id,ad_id,source_facebook_page_record_id,resolution_status,next_retry_at)
 values (b.tenant_id,'lease-ad',b.facebook_page_record_id,'pending',now())
 on conflict (tenant_id,ad_id) do nothing;
 select * into first_mapping from public.claim_due_meta_ad_name_resolution();
 perform pg_temp.assert_true(first_mapping.claim_token is not null, 'resolver claim issues ownership');
 perform pg_temp.assert_true((select claim_token is not null from public.meta_ads where tenant_id=first_mapping.tenant_id and ad_id=first_mapping.ad_id), 'only one claim token is stored for a mapping');
 update public.meta_ads set lease_expires_at=now()-interval '1 minute' where tenant_id=first_mapping.tenant_id and ad_id=first_mapping.ad_id;
 perform public.recover_meta_ad_name_resolutions();
 select * into second_mapping from public.claim_due_meta_ad_name_resolution();
 perform pg_temp.assert_true(second_mapping.claim_token is not null and second_mapping.claim_token <> first_mapping.claim_token, 'expired claim gets a new token');
 perform pg_temp.assert_true(not public.complete_meta_ad_name_resolution(first_mapping.tenant_id,first_mapping.ad_id,first_mapping.claim_token,'Stale Name'), 'stale resolver completion rejected');
 perform pg_temp.assert_true(public.complete_meta_ad_name_resolution(second_mapping.tenant_id,second_mapping.ad_id,second_mapping.claim_token,'Current Name'), 'current resolver completion succeeds');

 eid := pg_temp.new_event();
 select * into a from public.claim_meta_webhook_notification_event(eid);
 perform pg_temp.assert_true(public.complete_meta_lead_retrieval_event(eid,a.claim_token,'[]',null,'{}',now(),second_mapping.ad_id), 'lead completes against resolved mapping');
 perform pg_temp.assert_true((select ad_name='Current Name' from public.lead_data where webhook_notification_event_id=eid), 'resolved mapping reconciles inserted lead');

 insert into public.meta_ads(tenant_id,ad_id,source_facebook_page_record_id,resolution_status,next_retry_at)
 select a.tenant_id,'burst-ad',a.facebook_page_record_id,'pending',now()
 from generate_series(1,50) on conflict (tenant_id,ad_id) do nothing;
 perform pg_temp.assert_true((select count(*)=1 from public.meta_ads where tenant_id=a.tenant_id and ad_id='burst-ad'), 'fifty arrivals create one cache row');

 eid := pg_temp.new_event();
 select * into a from public.claim_meta_webhook_notification_event(eid);
 failed := false;
 begin
   perform public.complete_meta_lead_retrieval_event(eid,a.claim_token,'{}',null,'{}',now(),null);
 exception when others then failed := true;
 end;
 perform pg_temp.assert_true(failed and (select processing_status='processing' from public.meta_webhook_notification_events where id=eid), 'invalid lead write rolls back completion');

 -- A duplicate leadgen_id from a different tenant is rejected without changing the original row.
 insert into public.tenants(tenant_id, tenant_name) values ('42000000-0000-0000-0000-000000000001', 'Other Tenant');
 insert into public.meta_connections(id, tenant_id, meta_user_id, long_lived_user_access_token_encrypted)
 values ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', 'other-user', 'fixture');
 insert into public.facebook_pages(id, tenant_id, meta_connection_id, facebook_page_id, facebook_page_name, page_access_token_encrypted, connected_at)
 values ('42000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000002', 'other-page', 'Other Page', 'fixture', now());
 eid := pg_temp.new_event();
 select leadgen_id into duplicate_leadgen from public.meta_webhook_notification_events where id=eid;
 failed := false;
 begin
   insert into public.meta_webhook_notification_events(tenant_id, facebook_page_record_id, facebook_page_id, meta_entry_id, meta_entry_time, leadgen_id, form_id, lead_created_time, raw_webhook_change)
   values ('42000000-0000-0000-0000-000000000001','42000000-0000-0000-0000-000000000003','other-page','other-entry',now(),duplicate_leadgen,'other-form',now(),'{}');
 exception when unique_violation then failed := true; end;
 perform pg_temp.assert_true(failed, 'cross-tenant duplicate leadgen is rejected');
 perform pg_temp.assert_true((select tenant_id='10000000-0000-0000-0000-000000000001' from public.meta_webhook_notification_events where id=eid), 'duplicate cannot overwrite tenant ownership');

 -- Six resolver attempts exhaust the budget; a later lead does not reset it.
 update public.meta_ads set resolution_status='retry_exhausted', next_retry_at=null, claim_token=null, lease_expires_at=null
 where resolution_status in ('pending','transient_error');
 insert into public.meta_ads(tenant_id,ad_id,source_facebook_page_record_id,resolution_status,next_retry_at)
 values ('10000000-0000-0000-0000-000000000001','exhausted-ad','30000000-0000-0000-0000-000000000001','pending',now());
 for attempt in 1..6 loop
   select * into first_mapping from public.claim_due_meta_ad_name_resolution();
   perform pg_temp.assert_true(first_mapping.ad_id='exhausted-ad', 'retry test claims target mapping');
   perform pg_temp.assert_true(public.schedule_meta_ad_name_resolution_retry(first_mapping.tenant_id, first_mapping.ad_id, first_mapping.claim_token, 'transient_error', now(), 'TEST', 'retry'), 'retry attempt recorded');
 end loop;
 perform pg_temp.assert_true((select resolution_status='retry_exhausted' and retry_count=6 from public.meta_ads where ad_id='exhausted-ad'), 'retry budget exhausts at six attempts');
 eid := pg_temp.new_event();
 select * into a from public.claim_meta_webhook_notification_event(eid);
 perform pg_temp.assert_true(public.complete_meta_lead_retrieval_event(eid,a.claim_token,'[]',null,'{}',now(),'exhausted-ad'), 'new lead persists after retry exhaustion');
 perform pg_temp.assert_true((select retry_count=6 and resolution_status='retry_exhausted' from public.meta_ads where ad_id='exhausted-ad'), 'new lead cannot reset exhausted retry budget');
end;
$$;
rollback;

