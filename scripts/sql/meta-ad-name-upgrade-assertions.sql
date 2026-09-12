do $$
begin
  if not exists (select 1 from public.project_records_archive where project_id = '44000000-0000-0000-0000-000000000001') then
    raise exception 'TC30: project archive missing';
  end if;
  if not exists (select 1 from public.meta_ads where tenant_id = '11000000-0000-0000-0000-000000000001' and ad_id = 'upgrade-ad' and ad_name = 'Legacy Ad Name' and resolution_status = 'resolved') then
    raise exception 'TC21/TC30: historical ad cache backfill missing';
  end if;
  if not exists (select 1 from public.lead_data where id = '66000000-0000-0000-0000-000000000001' and ad_name = 'Legacy Ad Name') then
    raise exception 'TC21/TC30: historical lead name backfill missing';
  end if;
end;
$$;
