import { createSuccessResponse, createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  try {
    const supabase = await createAuthClient();
    const { error } = await supabase.auth.signOut();
    if (error) {
      throw error;
    }

    return createSuccessResponse({ signedOut: true });
  } catch (error) {
    return createErrorResponse(error);
  }
}
