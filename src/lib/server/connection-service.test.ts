// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionService } from "@/lib/server/connection-service";
import { LeadRecoveryService } from "@/lib/server/lead-recovery-service";
import { MetaClient, MetaGraphRequestError } from "@/lib/server/meta-client";
import { resolveTenantId } from "@/lib/server/tenant-context";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantId: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: vi.fn() }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (token: string) => `ciphertext:${token}`, decryptToken: () => "user-token" }));
vi.mock("@/lib/server/env", () => ({ getMetaEnv: vi.fn() }));
// Rate limiting is exercised in meta-rate-limit.test.ts against its own fake Redis. Here it is stubbed
// out so these tests cover connect/disconnect behaviour rather than Upstash configuration.
vi.mock("@/lib/server/meta-rate-limit", () => ({ assertMetaRateLimit: vi.fn() }));

const rpc = vi.fn();
const single = vi.fn();
// Rows returned when the builder is awaited directly, i.e. getAlreadyConnectedPageIds. Reset per test so
// a case that needs a pre-existing Page cannot leak that state into the next one.
let awaitedRows: unknown[] = [];
const query = {
  select: vi.fn(), update: vi.fn(), eq: vi.fn(), neq: vi.fn(), in: vi.fn(), order: vi.fn(), limit: vi.fn(), single,
  then: (onFulfilled: (value: { data: unknown[]; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: awaitedRows, error: null }).then(onFulfilled, onRejected),
};
const page = { facebookPageId: "page-1", facebookPageName: "Page One", assignedTasks: ["ADVERTISE", "MANAGE"], pageAccessToken: "page-token", missingTasks: [] };
const verified = { tokenExpiresAt: "2026-10-08T12:00:00.000Z", lastVerifiedAt: "2026-09-08T12:00:00.000Z" };

// A minimal stand-in for the Supabase query builder: chainable select/update/eq/neq, resolvable via an
// explicit .maybeSingle() call (disconnectPage) or by awaiting the builder itself, which the thenable
// protocol supports (disconnectConnection's unterminated select).
function makeQueryBuilder(result: { data: unknown; error?: unknown }) {
  const resolved = { data: result.data, error: result.error ?? null };
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.update = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.neq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn().mockResolvedValue(resolved);
  builder.then = (onFulfilled: (value: typeof resolved) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled, onRejected);
  return builder;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  awaitedRows = [];
  for (const method of [query.select, query.update, query.eq, query.neq, query.in, query.order, query.limit]) method.mockReturnValue(query);
  single.mockResolvedValue({ data: { connection_status: "active", user_token_status: "active", long_lived_user_access_token_encrypted: "encrypted-user-token" }, error: null });
  rpc.mockResolvedValue({ error: null });
  vi.mocked(resolveTenantId).mockResolvedValue("tenant-a");
  vi.mocked(getSupabaseAdminClient).mockReturnValue({ from: vi.fn(() => query), rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);
  vi.spyOn(MetaClient.prototype, "getEligiblePages").mockResolvedValue([page]);
  vi.spyOn(MetaClient.prototype, "validatePageToken").mockResolvedValue(verified);
  vi.spyOn(MetaClient.prototype, "subscribePageToLeadgen").mockResolvedValue();
  vi.spyOn(MetaClient.prototype, "confirmPageLeadgenSubscription").mockResolvedValue();
  vi.spyOn(LeadRecoveryService.prototype, "backfillReconnectedPages").mockResolvedValue();
  vi.spyOn(ConnectionService.prototype, "getOverview").mockResolvedValue({ connectionStatus: "active", pages: [] });
});

describe("connectSelectedPages", () => {
  it.each([verified.tokenExpiresAt, null])("persists only encrypted tokens and verified metadata (%s)", async (tokenExpiresAt) => {
    vi.mocked(MetaClient.prototype.validatePageToken).mockResolvedValue({ ...verified, tokenExpiresAt });
    await new ConnectionService().connectSelectedPages("connection-a", ["page-1"]);
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(MetaClient.prototype.validatePageToken).toHaveBeenCalledWith("page-1", "page-token");
    expect(rpc).toHaveBeenCalledWith("connect_selected_facebook_pages", {
      p_tenant_id: "tenant-a", p_connection_id: "connection-a",
      p_pages: [{ facebook_page_id: "page-1", facebook_page_name: "Page One", assigned_tasks: ["ADVERTISE", "MANAGE"],
        page_access_token_encrypted: "ciphertext:page-token", token_expires_at: tokenExpiresAt, last_verified_at: verified.lastVerifiedAt }],
    });
  });

  it("does not persist or subscribe any Page when one token fails verification", async () => {
    vi.mocked(MetaClient.prototype.getEligiblePages).mockResolvedValue([page, { ...page, facebookPageId: "page-2" }]);
    vi.mocked(MetaClient.prototype.validatePageToken).mockResolvedValueOnce(verified).mockRejectedValueOnce(new Error("verification failed"));
    await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1", "page-2"])).rejects.toThrow("verification failed");
    expect(rpc).not.toHaveBeenCalled();
    expect(MetaClient.prototype.subscribePageToLeadgen).not.toHaveBeenCalled();
  });

  it.each([{ pageIds: [] }, { pageIds: ["unknown-page"] }])("rejects invalid selections $pageIds", async ({ pageIds }) => {
    await expect(new ConnectionService().connectSelectedPages("connection-a", pageIds)).rejects.toMatchObject({ code: "META_PAGE_SELECTION_INVALID" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stops before database or Meta calls if tenant access is denied", async () => {
    vi.mocked(resolveTenantId).mockRejectedValue(new Error("access denied"));
    await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1"])).rejects.toThrow("access denied");
    expect(getSupabaseAdminClient).not.toHaveBeenCalled();
    expect(MetaClient.prototype.validatePageToken).not.toHaveBeenCalled();
  });

  it("rejects a connection outside the resolved tenant", async () => {
    single.mockResolvedValue({ data: null, error: null });
    await expect(new ConnectionService().connectSelectedPages("connection-b", ["page-1"])).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not save if subscription confirmation fails", async () => {
    vi.mocked(MetaClient.prototype.confirmPageLeadgenSubscription).mockRejectedValue(new Error("subscription failed"));
    await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1"])).rejects.toThrow("subscription failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports a database cross-tenant Page conflict as HTTP 409", async () => {
    rpc.mockResolvedValue({ error: { code: "P0001" } });
    await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1"])).rejects.toMatchObject({ status: 409, code: "FACEBOOK_PAGE_OWNERSHIP_CONFLICT" });
    expect(LeadRecoveryService.prototype.backfillReconnectedPages).not.toHaveBeenCalled();
  });

  describe("rollback when the database write fails", () => {
    beforeEach(() => {
      vi.spyOn(MetaClient.prototype, "unsubscribePageFromLeadgen").mockResolvedValue();
    });

    it.each([
      ["an ownership conflict", { code: "P0001" }],
      ["any other database error", { code: "XX000" }],
    ])("unsubscribes the Page it just subscribed when the RPC fails with %s", async (_label, rpcError) => {
      rpc.mockResolvedValue({ error: rpcError });
      await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1"])).rejects.toThrow();
      // Without this the Page stayed subscribed at Meta with no local record, so leadgen events kept
      // arriving for a Page no tenant owned.
      expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledExactlyOnceWith("page-1");
    });

    it("leaves a Page that was already connected before this request subscribed", async () => {
      // getAlreadyConnectedPageIds sees page-1 as already live, so rolling it back would break the
      // connection that already owns it - possibly another tenant's.
      awaitedRows = [{ facebook_page_id: "page-1" }];
      rpc.mockResolvedValue({ error: { code: "P0001" } });

      await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1"])).rejects.toThrow();
      expect(MetaClient.prototype.unsubscribePageFromLeadgen).not.toHaveBeenCalled();
    });
  });

  it("refuses a Page the person cannot manage before any Meta call is made", async () => {
    // ADVERTISE alone satisfies lead retrieval but not subscribed_apps, which needs CREATE_CONTENT,
    // MANAGE or MODERATE. This used to reach Meta and fail mid-batch, rolling back every other Page.
    vi.mocked(MetaClient.prototype.getEligiblePages).mockResolvedValue([
      { ...page, assignedTasks: ["ADVERTISE"], missingTasks: ["MANAGE or CREATE_CONTENT or MODERATE"] },
    ]);
    await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1"]))
      .rejects.toMatchObject({ status: 422, code: "META_PAGE_TASKS_INSUFFICIENT" });
    expect(MetaClient.prototype.validatePageToken).not.toHaveBeenCalled();
    expect(MetaClient.prototype.subscribePageToLeadgen).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("releases leads held for the reconnected Pages only after the Pages are saved", async () => {
    await new ConnectionService().connectSelectedPages("connection-a", ["page-1"]);
    const backfill = vi.mocked(LeadRecoveryService.prototype.backfillReconnectedPages);
    expect(backfill).toHaveBeenCalledExactlyOnceWith("tenant-a", ["page-1"]);
    expect(backfill.mock.invocationCallOrder[0]).toBeGreaterThan(rpc.mock.invocationCallOrder[0]);
  });

  it("keeps the Pages connected when releasing held leads fails", async () => {
    vi.mocked(LeadRecoveryService.prototype.backfillReconnectedPages).mockRejectedValue(new Error("release failed"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1"])).resolves.toEqual({ connectionStatus: "active", pages: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("BACKFILL_RELEASE_FAILED"));
  });

  it("refuses to load Pages with an expired user token", async () => {
    single.mockResolvedValue({ data: { connection_status: "active", user_token_status: "active", user_token_expires_at: "2020-01-01T00:00:00.000Z", long_lived_user_access_token_encrypted: "encrypted-user-token" }, error: null });
    await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1"])).rejects.toMatchObject({ code: "META_REAUTHORIZATION_REQUIRED" });
    expect(MetaClient.prototype.getEligiblePages).not.toHaveBeenCalled();
  });

  describe("subscribe rollback on partial failure", () => {
    const page2 = { ...page, facebookPageId: "page-2", facebookPageName: "Page Two" };
    const page3 = { ...page, facebookPageId: "page-3", facebookPageName: "Page Three" };

    beforeEach(() => {
      vi.mocked(MetaClient.prototype.getEligiblePages).mockResolvedValue([page, page2, page3]);
      vi.spyOn(MetaClient.prototype, "unsubscribePageFromLeadgen").mockResolvedValue();
    });

    it("unsubscribes pages 1..N-1 and re-throws the original error when page N fails to subscribe", async () => {
      vi.mocked(MetaClient.prototype.subscribePageToLeadgen).mockImplementation(async (facebookPageId) => {
        if (facebookPageId === "page-3") {
          throw new Error("subscribe failed");
        }
      });

      await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1", "page-2", "page-3"])).rejects.toThrow("subscribe failed");

      expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledTimes(2);
      expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledWith("page-1");
      expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledWith("page-2");
      expect(MetaClient.prototype.unsubscribePageFromLeadgen).not.toHaveBeenCalledWith("page-3");
      expect(rpc).not.toHaveBeenCalled();
    });

    it("continues rolling back the remaining pages, and still throws the original error, when a rollback unsubscribe itself fails", async () => {
      vi.mocked(MetaClient.prototype.subscribePageToLeadgen).mockImplementation(async (facebookPageId) => {
        if (facebookPageId === "page-3") {
          throw new Error("subscribe failed");
        }
      });
      vi.mocked(MetaClient.prototype.unsubscribePageFromLeadgen).mockRejectedValueOnce(new Error("unsubscribe failed for page-1"));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(new ConnectionService().connectSelectedPages("connection-a", ["page-1", "page-2", "page-3"])).rejects.toThrow("subscribe failed");

      expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledTimes(2);
      expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledWith("page-1");
      expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledWith("page-2");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("META_UNSUBSCRIBE_FAILED"));
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});

describe("disconnectPage", () => {
  beforeEach(() => {
    vi.spyOn(MetaClient.prototype, "unsubscribePageFromLeadgen").mockResolvedValue();
  });

  it("unsubscribes from Meta using the Page's facebook_page_id before updating the DB", async () => {
    const selectBuilder = makeQueryBuilder({ data: { facebook_page_id: "page-1" } });
    const updateBuilder = makeQueryBuilder({ data: { id: "page-record-1" } });
    const from = vi.fn().mockReturnValueOnce(selectBuilder).mockReturnValueOnce(updateBuilder);
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ from, rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);

    await new ConnectionService().disconnectPage("page-record-1");

    expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledExactlyOnceWith("page-1");
    const unsubscribeOrder = vi.mocked(MetaClient.prototype.unsubscribePageFromLeadgen).mock.invocationCallOrder[0];
    const updateCallOrder = (updateBuilder.update as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(unsubscribeOrder).toBeLessThan(updateCallOrder);
  });

  it("still completes the DB update when the Meta unsubscribe call throws", async () => {
    vi.mocked(MetaClient.prototype.unsubscribePageFromLeadgen).mockRejectedValue(new Error("unsubscribe failed"));
    const selectBuilder = makeQueryBuilder({ data: { facebook_page_id: "page-1" } });
    const updateBuilder = makeQueryBuilder({ data: { id: "page-record-1" } });
    const from = vi.fn().mockReturnValueOnce(selectBuilder).mockReturnValueOnce(updateBuilder);
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ from, rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(new ConnectionService().disconnectPage("page-record-1")).resolves.toEqual({ connectionStatus: "active", pages: [] });

    expect(updateBuilder.update).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("META_UNSUBSCRIBE_FAILED"));
  });
});

describe("disconnectConnection", () => {
  beforeEach(() => {
    vi.spyOn(MetaClient.prototype, "unsubscribePageFromLeadgen").mockResolvedValue();
  });

  it("unsubscribes every Page under the connection before calling the disconnect RPC", async () => {
    const selectBuilder = makeQueryBuilder({
      data: [{ facebook_page_id: "page-1" }, { facebook_page_id: "page-2" }],
    });
    const from = vi.fn().mockReturnValue(selectBuilder);
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ from, rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);

    await new ConnectionService().disconnectConnection("connection-a");

    expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledTimes(2);
    expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledWith("page-1");
    expect(MetaClient.prototype.unsubscribePageFromLeadgen).toHaveBeenCalledWith("page-2");
    const lastUnsubscribeOrder = vi.mocked(MetaClient.prototype.unsubscribePageFromLeadgen).mock.invocationCallOrder.at(-1);
    expect(lastUnsubscribeOrder).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  });

  it("still calls the disconnect RPC when a Page's Meta unsubscribe throws", async () => {
    vi.mocked(MetaClient.prototype.unsubscribePageFromLeadgen).mockRejectedValue(new Error("unsubscribe failed"));
    const selectBuilder = makeQueryBuilder({ data: [{ facebook_page_id: "page-1" }] });
    const from = vi.fn().mockReturnValue(selectBuilder);
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ from, rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(new ConnectionService().disconnectConnection("connection-a")).resolves.toEqual({ connectionStatus: "active", pages: [] });

    expect(rpc).toHaveBeenCalledWith("disconnect_meta_connection", { p_tenant_id: "tenant-a", p_connection_id: "connection-a" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("META_UNSUBSCRIBE_FAILED"));
  });
});

describe("getOverview connection status", () => {
  const now = new Date("2026-09-11T12:00:00.000Z");

  function mockConnections(connections: Array<{ connection_status: string; user_token_expires_at: string | null; data_access_expires_at?: string | null }>): void {
    const from = vi.fn((table: string) => {
      const builder = { select: vi.fn(), eq: vi.fn(), order: vi.fn().mockResolvedValue({ data: table === "meta_connections" ? connections.map((row, index) => ({ id: `connection-${index}`, ...row })) : [], error: null }) };
      builder.select.mockReturnValue(builder);
      builder.eq.mockReturnValue(builder);
      return builder;
    });
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ from, rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);
  }

  beforeEach(() => {
    vi.mocked(ConnectionService.prototype.getOverview).mockRestore();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ["null", null, "active"],
    ["in the future", "2026-09-11T12:00:00.001Z", "active"],
    ["in the past", "2026-09-11T11:59:59.999Z", "reauthorization_required"],
    ["exactly now", now.toISOString(), "reauthorization_required"],
  ])("derives an active connection whose user token expiry is %s as %s", async (_label, userTokenExpiresAt, expected) => {
    mockConnections([{ connection_status: "active", user_token_expires_at: userTokenExpiresAt }]);
    await expect(new ConnectionService().getOverview()).resolves.toMatchObject({ connectionStatus: expected });
  });

  it.each([
    ["null", null, "active"],
    ["in the future", "2026-09-11T12:00:00.001Z", "active"],
    ["in the past", "2026-09-11T11:59:59.999Z", "reauthorization_required"],
    ["exactly now", now.toISOString(), "reauthorization_required"],
  ])("derives an active connection whose data access expiry is %s as %s", async (_label, dataAccessExpiresAt, expected) => {
    // Data access is a second clock, independent of token expiry: per Meta's auth-vs-data guide it lapses
    // 90 days after the person was last active, and leads_retrieval is not a never-expiring permission.
    // The user token here is still valid and unexpired, which is exactly the case that used to show a
    // green "Active" badge on a connection that had silently stopped delivering leads.
    mockConnections([{ connection_status: "active", user_token_expires_at: null, data_access_expires_at: dataAccessExpiresAt }]);
    await expect(new ConnectionService().getOverview()).resolves.toMatchObject({ connectionStatus: expected });
  });

  it("leaves a disconnected connection disconnected even when its token has expired", async () => {
    mockConnections([{ connection_status: "disconnected", user_token_expires_at: "2020-01-01T00:00:00.000Z" }]);
    await expect(new ConnectionService().getOverview()).resolves.toMatchObject({ connectionStatus: "disconnected" });
  });

  it("derives the status at read time without writing it back", async () => {
    mockConnections([{ connection_status: "active", user_token_expires_at: "2020-01-01T00:00:00.000Z" }]);
    // The mocked query builders only support reads, so any update or upsert would reject here.
    await expect(new ConnectionService().getOverview()).resolves.toMatchObject({ connectionStatus: "reauthorization_required" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("expired or revoked Facebook authorization", () => {
  // Graph code 190 is what Facebook returns once the person removes the app from their Facebook
  // settings, or the token is otherwise revoked. Nothing in the stored expiry timestamps changes when
  // that happens, so a read-time status derivation cannot see it — the row has to be written.
  it("flags the connection and asks for re-authorization when Graph rejects the stored token", async () => {
    vi.mocked(MetaClient.prototype.getEligiblePages).mockRejectedValue(
      new MetaGraphRequestError({ status: 400, graphError: { code: 190, type: "OAuthException" } }),
    );

    await expect(new ConnectionService().getEligiblePages("connection-a")).rejects.toMatchObject({
      status: 403,
      code: "META_REAUTHORIZATION_REQUIRED",
    });
    expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
      connection_status: "reauthorization_required",
      user_token_status: "reauthorization_required",
    }));
  });

  it("leaves a transient Graph failure as a transient failure", async () => {
    vi.mocked(MetaClient.prototype.getEligiblePages).mockRejectedValue(new MetaGraphRequestError({ status: 500 }));

    await expect(new ConnectionService().getEligiblePages("connection-a")).rejects.toMatchObject({
      code: "META_TEMPORARY_FAILURE",
    });
    // A five-minute Facebook outage must not tell the tenant their authorization is gone.
    expect(query.update).not.toHaveBeenCalled();
  });
});

describe("concurrent Page subscription", () => {
  const threePages = ["page-1", "page-2", "page-3"];

  beforeEach(() => {
    vi.mocked(MetaClient.prototype.getEligiblePages).mockResolvedValue(
      threePages.map((facebookPageId) => ({ ...page, facebookPageId })),
    );
    vi.spyOn(MetaClient.prototype, "unsubscribePageFromLeadgen").mockResolvedValue();
  });

  it("subscribes every selected Page", async () => {
    await new ConnectionService().connectSelectedPages("connection-a", threePages);
    expect(MetaClient.prototype.subscribePageToLeadgen).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0][1].p_pages.map((row: { facebook_page_id: string }) => row.facebook_page_id)).toEqual(threePages);
  });

  // The rollback is only safe once nothing is still in flight: a subscription that lands after the
  // rollback has already run is orphaned at Meta with no local record and no second chance to undo it.
  it("waits for a slow in-flight subscription to land before rolling back a failed batch", async () => {
    vi.mocked(MetaClient.prototype.subscribePageToLeadgen).mockImplementation(async (facebookPageId) => {
      if (facebookPageId === "page-2") {
        throw new Error("subscribe failed");
      }
      if (facebookPageId === "page-3") {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });

    await expect(new ConnectionService().connectSelectedPages("connection-a", threePages)).rejects.toThrow("subscribe failed");
    expect(rpc).not.toHaveBeenCalled();
    const rolledBack = vi.mocked(MetaClient.prototype.unsubscribePageFromLeadgen).mock.calls.map(([id]) => id);
    expect(rolledBack.sort()).toEqual(["page-1", "page-3"]);
  });

  // Failure order must come from the input, not from whichever request happened to lose the race.
  it("reports the first failure in selection order, not the first to return", async () => {
    vi.mocked(MetaClient.prototype.subscribePageToLeadgen).mockImplementation(async (facebookPageId) => {
      if (facebookPageId === "page-2") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("page-2 failed");
      }
      if (facebookPageId === "page-3") {
        throw new Error("page-3 failed");
      }
    });

    await expect(new ConnectionService().connectSelectedPages("connection-a", threePages)).rejects.toThrow("page-2 failed");
  });
});
