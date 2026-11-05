-- /leads "new leads arrived" bar: tell an update signal apart from a new lead.
--
-- Every lead_data write sends the same "lead_change" signal (20260929120000), so each open /leads tab checked for new
-- leads after every status, label, assignee or ad-name change too. The count only includes leads saved after the
-- table's cursor (created_at > since), so a change to leads saved at or before it can never change the count.
-- notify_lead_update now also sends, per company, the newest created_at among the rows the statement changed, as
-- whole microseconds since 1970 in a digit string (exact: a JSON number could be re-encoded as a float on the way).
-- /leads skips its check when that is not after its cursor; anything else (no value, a bad value) still checks.
--
-- Only notify_lead_update changes. notify_lead_insert (every Facebook, Google Ads and call-in lead save) and
-- notify_lead_delete are untouched, and no trigger is dropped or recreated, so lead_data is never locked. The new
-- lines run inside the existing "exception when others then null" block: if they ever fail, the update still saves
-- and only the signal is skipped. "t" stays; the Dashboard and Tasks pages ignore the payload as before.
-- created_at is not null with default now(), so the newest value always exists.
-- Undo: supabase/rollbacks/20261105150000_lead_update_signal_newest_saved.rollback.sql.

begin;
set local lock_timeout = '5s';

create or replace function public.notify_lead_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_newest timestamptz;
begin
  begin
    for v_tenant, v_newest in select tenant_id, max(created_at) from new_rows group by tenant_id loop
      perform realtime.send(jsonb_build_object('t', now(), 'kind', 'update',
        'newest_saved_us', ((extract(epoch from v_newest) * 1000000)::bigint)::text),
        'lead_change', 'dashboard:' || v_tenant::text, true);
    end loop;
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke all on function public.notify_lead_update() from public, anon, authenticated;

commit;
