import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnvironment } from "@/lib/server/env";

let supabaseAdminClient: SupabaseClient | undefined;

export function getSupabaseAdminClient(): SupabaseClient {
  if (!supabaseAdminClient) {
    const environment = getServerEnvironment();
    supabaseAdminClient = createClient(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return supabaseAdminClient;
}
