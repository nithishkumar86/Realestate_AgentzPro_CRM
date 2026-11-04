-- Undo 20261103120000_google_campaign_filter.sql.
--
-- Order: revert the app FIRST (the dashboard calls get_dashboard_platform_stats_v2 and the lead filters call
-- list_google_lead_campaigns), then run this. The old get_dashboard_platform_stats was never changed, so the
-- reverted app keeps working. No data is touched.

begin;

drop function if exists public.get_dashboard_platform_stats_v2(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, text);
drop function if exists public.list_google_lead_campaigns(uuid);

notify pgrst, 'reload schema';

commit;
