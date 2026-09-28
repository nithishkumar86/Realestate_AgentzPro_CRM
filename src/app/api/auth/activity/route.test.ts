import { beforeEach, expect, it, vi } from "vitest";
import { stubSupabaseEnv } from "@/test/supabase-env";
import { isSessionActive } from "@/lib/server/auth/idle-session";
import { AppError } from "@/lib/server/app-error";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ verifySession: vi.fn(), assertSameOrigin: vi.fn() }));
vi.mock("@/lib/server/auth/session", () => ({ verifySession: mocks.verifySession }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));

const request = () => new Request("https://crm.example.com/api/auth/activity", { method: "POST" });
const activityCookie = (response: Response) => /agentz_last_activity=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1];

beforeEach(() => {
  vi.resetAllMocks();
  stubSupabaseEnv();
});

it("renews the idle clock of a live session with the server's time", async () => {
  mocks.verifySession.mockResolvedValue({ userId: "user-1" });
  const input = request();
  const response = await POST(input);
  expect(mocks.assertSameOrigin).toHaveBeenCalledWith(input);
  expect(response.status).toBe(200);
  expect(isSessionActive(activityCookie(response), "user-1")).toBe(true);
  expect(response.headers.get("cache-control")).toContain("no-store");
});

it("answers 401 and renews nothing when there is no session", async () => {
  mocks.verifySession.mockResolvedValue(null);
  const response = await POST(request());
  expect(response.status).toBe(401);
  expect(activityCookie(response)).toBeUndefined();
});

it("refuses a cross-site request before looking at the session", async () => {
  mocks.assertSameOrigin.mockImplementation(() => { throw new AppError("Cross-site", { status: 403, code: "FORBIDDEN" }); });
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(mocks.verifySession).not.toHaveBeenCalled();
  expect(activityCookie(response)).toBeUndefined();
});
