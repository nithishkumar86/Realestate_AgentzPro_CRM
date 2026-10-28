import { z } from "zod";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";

export const runtime = "nodejs";

const saveAccountsSchema = z.object({ customerIds: z.array(z.string().regex(/^\d{10}$/)).max(50) }).strict();

// The Google Ads accounts the signed-in Google user can reach, with the ones already picked marked.
export async function GET(request: Request) {
  try {
    return createSuccessResponse({ accounts: await new GoogleConnectionService().listAccountOptions() });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, saveAccountsSchema);
    await new GoogleConnectionService().saveAccounts([...new Set(body.customerIds)]);
    return createSuccessResponse({ saved: true });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
