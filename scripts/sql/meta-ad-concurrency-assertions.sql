do $$
declare mapping public.meta_ads; lead_count integer; named_count integer;
begin
  if (select count(*) from public.meta_ad_concurrency_results) <> 1 then
    raise exception 'TC05/TC16: concurrent sessions produced more than one active claim';
  end if;
  select count(*) into lead_count from public.lead_data where leadgen_id like 'concurrent-lead-%';
  if lead_count <> 50 then raise exception 'TC05: expected 50 persisted leads, got %', lead_count; end if;
  select * into mapping from public.meta_ads where tenant_id = '13000000-0000-0000-0000-000000000001' and ad_id = 'concurrent-ad' for update;
  if not public.complete_meta_ad_name_resolution(mapping.tenant_id, mapping.ad_id, mapping.claim_token, 'Concurrent Name') then
    raise exception 'TC06/TC19: current resolver could not complete';
  end if;
  select count(*) into named_count from public.lead_data where leadgen_id like 'concurrent-lead-%' and ad_name = 'Concurrent Name';
  if named_count <> 50 then raise exception 'TC19/TC20: expected 50 reconciled names, got %', named_count; end if;
end;
$$;
