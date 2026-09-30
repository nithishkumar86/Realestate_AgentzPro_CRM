import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ActiveTenantGuard } = await import("@/features/workspaces/active-tenant-guard");

const TENANT_A = "10000000-0000-4000-8000-00000000000a";

const reload = vi.fn();
let baseFetch: ReturnType<typeof vi.fn>;
const realFetch = window.fetch;

beforeEach(() => {
  reload.mockReset();
  vi.stubGlobal("location", { origin: "http://localhost", href: "http://localhost/leads", reload });
  baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
  window.fetch = baseFetch as unknown as typeof window.fetch;
});

afterEach(() => {
  window.fetch = realFetch;
  vi.unstubAllGlobals();
});

function headerSent(call = 0): string | null {
  const init = baseFetch.mock.calls[call]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers).get("x-active-tenant");
}

describe("ActiveTenantGuard", () => {
  it("adds the rendered company to CRM api calls and keeps the caller's own headers", async () => {
    render(<ActiveTenantGuard tenantId={TENANT_A} />);

    await window.fetch("/api/leads/query", { method: "POST", headers: { "content-type": "application/json" } });

    expect(headerSent()).toBe(TENANT_A);
    const init = baseFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.method).toBe("POST");
  });

  it("leaves company switching, auth and non-api calls untouched", async () => {
    render(<ActiveTenantGuard tenantId={TENANT_A} />);

    await window.fetch("/api/workspaces/active", { method: "POST" });
    await window.fetch("/api/auth/logout", { method: "POST" });
    await window.fetch("/some/page");
    await window.fetch("https://example.com/api/leads");

    for (let call = 0; call < 4; call += 1) {
      expect(headerSent(call)).toBeNull();
    }
  });

  it("reloads into the active company when the server answers WORKSPACE_CHANGED", async () => {
    baseFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "WORKSPACE_CHANGED" } }), { status: 409 }),
    );
    render(<ActiveTenantGuard tenantId={TENANT_A} />);

    const response = await window.fetch("/api/leads/query", { method: "POST" });

    expect(response.status).toBe(409);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for other 409s", async () => {
    baseFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "INVITATION_PENDING" } }), { status: 409 }));
    render(<ActiveTenantGuard tenantId={TENANT_A} />);

    await window.fetch("/api/leads/query", { method: "POST" });

    expect(reload).not.toHaveBeenCalled();
  });

  it("restores the original fetch when unmounted", () => {
    const { unmount } = render(<ActiveTenantGuard tenantId={TENANT_A} />);
    expect(window.fetch).not.toBe(baseFetch);

    unmount();

    expect(window.fetch).toBe(baseFetch);
  });
});
