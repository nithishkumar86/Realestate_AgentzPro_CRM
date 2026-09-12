set statement_timeout = '30s';
begin;
with claimed as (select * from public.claim_due_meta_ad_name_resolution())
insert into public.meta_ad_concurrency_results(session_name, claim_token)
select 'worker-a', claim_token from claimed;
select pg_sleep(2);
commit;
