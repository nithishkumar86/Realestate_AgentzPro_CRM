-- ROLLBACK for supabase/migrations/20261029120000_dashboard_platform_stats.sql. Never applied automatically: this
-- folder is not supabase/migrations. Run by hand, only on the owner's explicit OK.
--
-- Order: revert the app FIRST (the platform dashboard calls get_dashboard_platform_stats), then run this.
-- get_dashboard_stats was never changed by the migration, so the previous app version needs nothing restored.

begin;

drop function if exists public.get_dashboard_platform_stats(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text);

notify pgrst, 'reload schema';

commit;
