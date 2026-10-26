// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/telecaller-lead-service", () => ({ createTelecallerLead: mocks.create }));

import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://localhost/api/leads/telecaller", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const valid = { leadName: "  Ravi  ", phone: " 98765 43210 ", whatsapp: "", projectName: " Karuvi " };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
});

describe("POST /api/leads/telecaller", () => {
  it("saves the trimmed lead for the session's tenant and answers 201; an empty WhatsApp is dropped", async () => {
    mocks.create.mockResolvedValue({ id: "lead-1" });
    const response = await post(valid);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "lead-1" });
    expect(mocks.create).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, { leadName: "Ravi", phone: "98765 43210", whatsapp: undefined, projectName: "Karuvi" });
  });

  it.each([
    [{ ...valid, leadName: "  " }],
    [{ ...valid, phone: "12345" }],
    [{ ...valid, whatsapp: "123" }],
    [{ ...valid, projectName: "" }],
    [{ ...valid, leadName: "x".repeat(201) }],
    [{ ...valid, tenantId: "tenant-b" }],
    [{ leadName: "Ravi" }],
  ])("rejects %j with 400", async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
