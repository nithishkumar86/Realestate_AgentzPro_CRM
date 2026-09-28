import { vi } from "vitest";

/** Server config for code that signs with the service-role key (e.g. the idle-activity cookie). */
export function stubSupabaseEnv(): void {
  vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key-0123456789");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key-0123456789");
}
