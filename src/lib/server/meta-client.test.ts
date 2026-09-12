// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaClient } from "@/lib/server/meta-client";

vi.mock("@/lib/server/env", () => ({
  getMetaEnv: () => ({ META_APP_ID: "app-1", META_APP_SECRET: "test-secret", META_GRAPH_API_VERSION: "v26.0" }),
}));

const fetchMock = vi.fn();
const now = new Date("2026-09-08T12:00:00.000Z");
const future = Math.floor(now.getTime() / 1000) + 3600;
const validToken = { is_valid: true, app_id: "app-1", profile_id: "page-1", expires_at: future };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Page token verification", () => {
  it.each([future, 0])("preserves verified expiry %s", async (expiresAt) => {
    fetchMock.mockResolvedValue(Response.json({ data: { ...validToken, expires_at: expiresAt } }));
    await expect(new MetaClient().validatePageToken("page-1", "page-token")).resolves.toEqual({
      tokenExpiresAt: expiresAt === 0 ? null : "2026-09-08T13:00:00.000Z",
      lastVerifiedAt: now.toISOString(),
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.hostname).toBe("graph.facebook.com");
    expect(url.pathname).toBe("/v26.0/debug_token");
    expect(url.searchParams.get("input_token")).toBe("page-token");
    expect(url.searchParams.get("access_token")).toBe("app-1|test-secret");
  });

  it.each([
    { is_valid: false }, { is_valid: "true" }, { app_id: "another-app" },
    { profile_id: "another-page" }, { profile_id: undefined },
  ])("rejects invalid validity, app, or Page identity: %j", async (override) => {
    fetchMock.mockResolvedValue(Response.json({ data: { ...validToken, ...override } }));
    await expect(new MetaClient().validatePageToken("page-1", "page-token")).rejects.toMatchObject({ code: "META_PAGE_TOKEN_INVALID" });
  });

  it.each([undefined, null, "0", -1, 0.5, 9e15])("rejects unknown or malformed expiry %s", async (expiresAt) => {
    fetchMock.mockResolvedValue(Response.json({ data: { ...validToken, expires_at: expiresAt } }));
    await expect(new MetaClient().validatePageToken("page-1", "page-token")).rejects.toMatchObject({ code: "META_PAGE_TOKEN_METADATA_INVALID" });
  });

  it.each(["expires_at", "data_access_expires_at"])("rejects expired %s even when is_valid is true", async (field) => {
    fetchMock.mockResolvedValue(Response.json({ data: { ...validToken, [field]: Math.floor(now.getTime() / 1000) } }));
    await expect(new MetaClient().validatePageToken("page-1", "page-token")).rejects.toMatchObject({ code: "META_PAGE_TOKEN_EXPIRED" });
  });

  it("rejects a failed Graph verification request", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: {} }, { status: 400 }));
    await expect(new MetaClient().validatePageToken("page-1", "page-token")).rejects.toMatchObject({ code: "META_REQUEST_REJECTED" });
  });
});

describe("Graph error classification", () => {
  const lead = () => new MetaClient().retrieveLead("lead-1", "page-token");

  // Meta-documented throttling codes (application/page-level and Business Use Case), verified
  // individually against https://developers.facebook.com/docs/graph-api/guides/error-handling and
  // https://developers.facebook.com/docs/graph-api/overview/rate-limiting on 2026-09-11.
  // The transport actually retries retryable codes (3 attempts, jittered backoff), so these await a live
  // setTimeout under fake timers — advance them with runAllTimersAsync or the assertion never settles.
  it.each([4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014])(
    "retries documented throttling code %s even though Meta returns HTTP 400",
    async (code) => {
      // A fresh Response per call: reusing one instance across retries would exhaust its body
      // stream after the first .json() read, silently losing the error code on later attempts.
      fetchMock.mockImplementation(() => Promise.resolve(Response.json({ error: { code, type: "OAuthException" } }, { status: 400 })));
      // Attach the rejection handler before advancing timers, or the retry-loop's rejection can fire
      // while nothing has claimed it yet and Node reports it as an unhandled rejection.
      const assertion = expect(lead()).rejects.toMatchObject({ retryable: true, requiresReauthorization: false });
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  // 80007 and 80010-80013 are NOT documented by Meta but fall inside the 80000-80014 range check.
  // This test pins current (deliberate, over-retry-is-safer) behavior so a future narrowing of the
  // range is caught here instead of silently changing retry behavior for these codes.
  it("still retries undocumented-but-in-range code 80010, per the current deliberate range choice", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ error: { code: 80010, type: "OAuthException" } }, { status: 400 })));
    const assertion = expect(lead()).rejects.toMatchObject({ retryable: true, requiresReauthorization: false });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([190, 102, 10, 200, 250, 299])("requires reauthorization for code %s", async (code) => {
    fetchMock.mockResolvedValue(Response.json({ error: { code, type: "OAuthException" } }, { status: 400 }));
    await expect(lead()).rejects.toMatchObject({ retryable: false, requiresReauthorization: true });
  });

  it("identifies GraphMethodException 100/33 without assuming reauthorization", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: 100, error_subcode: 33, type: "GraphMethodException" } }, { status: 400 }));
    await expect(lead()).rejects.toMatchObject({ isObjectAccessDenied: true, requiresReauthorization: false, retryable: false });
  });
});

describe("Page lead access check", () => {
  it.each([
    [{ scopes: ["leads_retrieval"] }, true],
    [{ scopes: ["pages_show_list"] }, false],
    [{ scopes: undefined }, false],
    [{ scopes: ["leads_retrieval"], is_valid: false }, false],
    [{ scopes: ["leads_retrieval"], profile_id: "another-page" }, false],
    [{ scopes: ["leads_retrieval"], app_id: "another-app" }, false],
  ])("evaluates %j as %s", async (override, expected) => {
    fetchMock.mockResolvedValue(Response.json({ data: { ...validToken, ...override } }));
    await expect(new MetaClient().hasPageLeadAccess("page-1", "page-token")).resolves.toBe(expected);
  });
});

describe("Page leadgen unsubscribe", () => {
  it("calls DELETE with the app access token, not a page token", async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true }));
    await new MetaClient().unsubscribePageFromLeadgen("page-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/v26.0/page-1/subscribed_apps");
    expect(url.searchParams.get("access_token")).toBe("app-1|test-secret");
    expect(requestInit.method).toBe("DELETE");
    // The point of the assertion is that no Page bearer token rides along; the transport now always
    // passes a headers object, so check the header itself rather than the object's absence.
    expect((requestInit.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
  });

  it("rejects a success:false response as a MetaGraphRequestError", async () => {
    fetchMock.mockResolvedValue(Response.json({ success: false }));
    await expect(new MetaClient().unsubscribePageFromLeadgen("page-1")).rejects.toMatchObject({
      code: "META_PAGE_UNSUBSCRIBE_FAILED",
    });
  });

  it("rejects a non-2xx response as a MetaGraphRequestError", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: 1 } }, { status: 400 }));
    await expect(new MetaClient().unsubscribePageFromLeadgen("page-1")).rejects.toMatchObject({
      code: "META_REQUEST_REJECTED",
    });
  });
});

describe("Ad name retrieval", () => {
  it("requests only id and name and rejects an empty name", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "ad-1", name: "Campaign Alpha" }));
    await expect(new MetaClient().retrieveAdName("ad-1", "user-token")).resolves.toBe("Campaign Alpha");
    const request = fetchMock.mock.calls[0];
    const url = new URL(request[0]);
    expect(url.pathname).toBe("/v26.0/ad-1");
    expect(url.searchParams.get("fields")).toBe("id,name");
    expect(request[1].headers.authorization).toBe("Bearer user-token");

    fetchMock.mockResolvedValue(Response.json({ id: "ad-1", name: "  " }));
    await expect(new MetaClient().retrieveAdName("ad-1", "user-token")).rejects.toMatchObject({ code: "META_AD_RESPONSE_INVALID" });
  });

  it("rejects a response for a different ad", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "ad-2", name: "Wrong ad" }));
    await expect(new MetaClient().retrieveAdName("ad-1", "user-token")).rejects.toMatchObject({ code: "META_AD_RESPONSE_INVALID" });
  });
});

describe("Page task eligibility", () => {
  const allPermissions = ["pages_read_engagement", "pages_manage_metadata", "pages_manage_ads", "pages_show_list", "ads_management", "leads_retrieval"];

  function pagesResponse(tasks: string[]) {
    return Response.json({ data: [{ id: "page-1", name: "Page One", access_token: "page-token", tasks }] });
  }

  it.each([
    [["ADVERTISE", "MANAGE"], []],
    [["ADVERTISE", "CREATE_CONTENT"], []],
    [["ADVERTISE", "MODERATE"], []],
    // ADVERTISE satisfies lead retrieval but NOT subscribed_apps, which the docs gate on
    // CREATE_CONTENT, MANAGE or MODERATE. This is the case that used to poison a whole connect batch.
    [["ADVERTISE"], ["MANAGE or CREATE_CONTENT or MODERATE"]],
    [["MANAGE"], ["ADVERTISE"]],
    [["ANALYZE"], ["ADVERTISE", "MANAGE or CREATE_CONTENT or MODERATE"]],
  ])("reports tasks %j as missing %j", async (tasks, missingTasks) => {
    fetchMock.mockResolvedValue(pagesResponse(tasks));
    await expect(new MetaClient().getEligiblePages("user-token")).resolves.toEqual([
      { facebookPageId: "page-1", facebookPageName: "Page One", assignedTasks: tasks, pageAccessToken: "page-token", missingTasks },
    ]);
  });

  it("still drops a Page with no access token, which cannot be used at all", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: "page-1", name: "Page One", tasks: ["ADVERTISE", "MANAGE"] }] }));
    await expect(new MetaClient().getEligiblePages("user-token")).resolves.toEqual([]);
  });

  it("names the declined permissions so the browser can re-request exactly those", async () => {
    fetchMock.mockResolvedValue(Response.json({
      data: { is_valid: true, app_id: "app-1", user_id: "user-1", scopes: allPermissions.filter((scope) => scope !== "leads_retrieval") },
    }));
    await expect(new MetaClient().validateUserToken("user-token")).rejects.toMatchObject({
      status: 403,
      code: "META_PERMISSION_DENIED",
      details: { missingPermissions: ["leads_retrieval"] },
    });
  });
});

describe("App authorization revocation", () => {
  it("calls DELETE /{user-id}/permissions with the app access token", async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true }));
    await new MetaClient().revokeAppAuthorization("user-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v26.0/user-1/permissions");
    expect(String(url)).toContain("access_token=app-1%7Ctest-secret");
    expect(init).toMatchObject({ method: "DELETE" });
  });

  it("accepts a bare true response, which is the shape the docs describe", async () => {
    fetchMock.mockResolvedValue(Response.json(true));
    await expect(new MetaClient().revokeAppAuthorization("user-1")).resolves.toBeUndefined();
  });

  it("treats an unsuccessful response as a retryable failure", async () => {
    fetchMock.mockResolvedValue(Response.json({ success: false }));
    await expect(new MetaClient().revokeAppAuthorization("user-1")).rejects.toMatchObject({ code: "META_REVOKE_FAILED", retryable: true });
  });
});

describe("Throttle-aware retry budget", () => {
  const lead = () => new MetaClient().retrieveLead("lead-1", "page-token");

  function throttled(headers: Record<string, string>, status = 400): Response {
    return Response.json({ error: { code: 80004, type: "OAuthException" } }, { status, headers });
  }

  // Meta reports Business Use Case throttling as estimated_time_to_regain_access, in MINUTES
  // (https://developers.facebook.com/docs/graph-api/overview/rate-limiting). Retrying into a block that
  // long cannot succeed and each attempt extends it, so the call must abort after one try and hand the
  // wait back to the caller.
  it("gives up after one attempt when Meta asks for longer than the inline budget", async () => {
    const usage = JSON.stringify({ "business-1": [{ type: "ads_management", estimated_time_to_regain_access: 19 }] });
    fetchMock.mockImplementation(() => Promise.resolve(throttled({ "x-business-use-case-usage": usage })));

    const assertion = expect(lead()).rejects.toMatchObject({
      retryable: true,
      retryAfterSeconds: 19 * 60,
      details: { retryAfterSeconds: 19 * 60 },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes the largest wait across every business and bucket in the header", async () => {
    const usage = JSON.stringify({
      "business-1": [{ estimated_time_to_regain_access: 2 }],
      "business-2": [{ estimated_time_to_regain_access: 7 }, { estimated_time_to_regain_access: 4 }],
    });
    fetchMock.mockImplementation(() => Promise.resolve(throttled({ "x-business-use-case-usage": usage })));

    const assertion = expect(lead()).rejects.toMatchObject({ retryAfterSeconds: 7 * 60 });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("reads reset_time_duration from x-ad-account-usage, which is already in seconds", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(throttled({ "x-ad-account-usage": JSON.stringify({ reset_time_duration: 300 }) })));

    const assertion = expect(lead()).rejects.toMatchObject({ retryAfterSeconds: 300 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries when the wait Meta asks for fits inside the budget", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(throttled({ "retry-after": "1" }, 429)));

    const assertion = expect(lead()).rejects.toMatchObject({ retryable: true, retryAfterSeconds: 1 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // A malformed header must never produce NaN, a negative delay, or an exception on an error path.
  it.each(["not json", "{}", '{"business-1":"unexpected"}'])("falls back to backoff for header %j", async (usage) => {
    fetchMock.mockImplementation(() => Promise.resolve(throttled({ "x-business-use-case-usage": usage })));

    const assertion = expect(lead()).rejects.toMatchObject({ retryable: true, retryAfterSeconds: null });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("Subscribed apps confirmation", () => {
  const cursor = "https://graph.facebook.com/v26.0/page-1/subscribed_apps?after=cursor-1";

  it("finds this app on a later page rather than reporting the subscription unconfirmed", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ data: [{ id: "other-app", subscribed_fields: ["leadgen"] }], paging: { next: cursor } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "app-1", subscribed_fields: ["leadgen"] }] }));

    await expect(new MetaClient().confirmPageLeadgenSubscription("page-1", "page-token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Graph omits the token from cursor URLs when it was sent as a header, so the header has to be re-sent.
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).authorization).toBe("Bearer page-token");
    expect(fetchMock.mock.calls[1][0]).toBe(cursor);
  });

  it("reports the subscription unconfirmed when no page contains this app", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ data: [{ id: "other-app", subscribed_fields: ["leadgen"] }], paging: { next: cursor } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "app-1", subscribed_fields: ["feed"] }] }));

    await expect(new MetaClient().confirmPageLeadgenSubscription("page-1", "page-token"))
      .rejects.toMatchObject({ code: "META_PAGE_SUBSCRIPTION_UNCONFIRMED", retryable: true });
  });
});

describe("Eligible page pagination", () => {
  it("follows paging.next across pages", async () => {
    const next = "https://graph.facebook.com/v26.0/me/accounts?after=cursor-1";
    fetchMock
      .mockResolvedValueOnce(Response.json({
        data: [{ id: "page-1", name: "One", access_token: "token-1", tasks: ["ADVERTISE", "MANAGE"] }],
        paging: { next },
      }))
      .mockResolvedValueOnce(Response.json({
        data: [{ id: "page-2", name: "Two", access_token: "token-2", tasks: ["ADVERTISE", "MODERATE"] }],
      }));

    const pages = await new MetaClient().getEligiblePages("user-token");
    expect(pages.map((page) => page.facebookPageId)).toEqual(["page-1", "page-2"]);
  });

  // A cursor that returns itself used to hold the invocation until the platform timeout killed it, with
  // no error anyone could act on.
  it("stops with a typed error instead of following a self-referential cursor forever", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({
      data: [],
      paging: { next: "https://graph.facebook.com/v26.0/me/accounts?after=always-the-same" },
    })));

    await expect(new MetaClient().getEligiblePages("user-token")).rejects.toMatchObject({ code: "META_PAGE_LIST_TOO_LARGE" });
    expect(fetchMock).toHaveBeenCalledTimes(50);
  });
});
