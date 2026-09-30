"use client";

import { useEffect } from "react";
import { ACTIVE_TENANT_HEADER, WORKSPACE_CHANGED_CODE } from "@/lib/active-tenant-header";

// Calls that pick or change the company themselves, or run before one exists, must not carry a claim.
const EXEMPT_PREFIXES = ["/api/workspaces", "/api/auth"];

function isGuardedPath(url: URL): boolean {
  return (
    url.origin === window.location.origin &&
    url.pathname.startsWith("/api/") &&
    !EXEMPT_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
  );
}

/**
 * The active company is one cookie for the whole browser, so another tab can switch it while this
 * page still shows the old company. Every same-origin /api call from this page carries the company
 * it was rendered for; when the server answers WORKSPACE_CHANGED the page reloads into the company
 * that is really active, instead of silently reading or changing the other company's data.
 */
export function ActiveTenantGuard({ tenantId }: Readonly<{ tenantId: string }>) {
  useEffect(() => {
    const originalFetch = window.fetch;

    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (!isGuardedPath(url)) {
        return originalFetch(input, init);
      }

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set(ACTIVE_TENANT_HEADER, tenantId);

      const response = await originalFetch(input, { ...init, headers });
      if (response.status === 409) {
        const payload = (await response.clone().json().catch(() => null)) as { error?: { code?: string } } | null;
        if (payload?.error?.code === WORKSPACE_CHANGED_CODE) {
          window.location.reload();
        }
      }
      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [tenantId]);

  return null;
}
