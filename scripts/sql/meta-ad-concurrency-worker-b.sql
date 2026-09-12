set statement_timeout = '30s';
do $$
declare event_row record;
begin
  for event_row in select id, claim_token from public.meta_webhook_notification_events where leadgen_id like 'concurrent-lead-%' order by leadgen_id loop
    perform public.complete_meta_lead_retrieval_event(event_row.id, event_row.claim_token, '[]', null, '{}', now(), 'concurrent-ad');
  end loop;
end;
$$;
