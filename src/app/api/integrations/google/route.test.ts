// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn() }));
vi.mock("@/lib/server/google/google-connection-service", () => ({
  GoogleConnectionService: class { getOverview = mocks.getOverview; },
}));

import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getOverview.mockResolvedValue({ hasWebhook: true });
});

describe("GET /api/integrations/google", () => {
  it("adds the campaign ticks only when the Connection card asks with ?campaigns=1", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/google?campaigns=1"));
    expect(response.status).toBe(200);
    expect(mocks.getOverview).toHaveBeenCalledWith("http://localhost", { includeCampaigns: true });
  });

  it("leaves them out for every other caller (/leads, dashboard)", async () => {
    await GET(new Request("http://localhost/api/integrations/google"));
    expect(mocks.getOverview).toHaveBeenCalledWith("http://localhost", { includeCampaigns: false });
  });
});
