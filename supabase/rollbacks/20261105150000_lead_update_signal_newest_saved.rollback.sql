-- Undo 20261105150000_lead_update_signal_newest_saved.sql: notify_lead_update goes back to exactly the body of
-- 20260929120000 (copied from the live definition on 2026-11-05).
--
-- No app change is needed first: without "newest_saved_us" /leads checks after every update again, as before. The
-- trigger itself is not touched. No data is touched.

begin;
set local lock_timeout = '5s';

create or replace function public.notify_lead_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  begin
    for v_tenant in select distinct tenant_id from new_rows loop
      perform realtime.send(jsonb_build_object('t', now()), 'lead_change', 'dashboard:' || v_tenant::text, true);
    end loop;
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke all on function public.notify_lead_update() from public, anon, authenticated;

commit;
