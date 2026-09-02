import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getServerEnvironment } from "@/lib/server/env";

export async function resolveTenantId(): Promise<string> {
  if (process.env.NODE_ENV === "production") {
    throw new AppError("Tenant authentication is required before this endpoint can run in production.", {
      status: 503,
      code: "TENANT_CONTEXT_UNAVAILABLE",
    });
  }

  return getServerEnvironment().META_TEST_TENANT_ID;
}
