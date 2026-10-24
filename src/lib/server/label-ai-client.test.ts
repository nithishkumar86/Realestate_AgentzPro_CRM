// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiClassificationError, classifyLead } from "@/lib/server/label-ai-client";

vi.mock("@/lib/server/ai-env", () => ({
  getAiEnv: () => ({ PORTKEY_API_KEY: "test-key", PORTKEY_CONFIG_ID: "test-config" }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function respondWithContent(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

const input = { redactedFields: [{ name: "budget", values: ["50 lakh"] }], adName: "Spring Sale", status: "New Lead" };

describe("classifyLead", () => {
  it("sends the Portkey headers and returns a valid classification", async () => {
    fetchMock.mockResolvedValue(respondWithContent(JSON.stringify({ label: "Hot", confidence: 0.87, reason: "Ready to buy" })));
    const result = await classifyLead(input);
    expect(result).toEqual({ label: "Hot", confidence: 0.87, reason: "Ready to buy" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.portkey.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>)["x-portkey-api-key"]).toBe("test-key");
    expect((init.headers as Record<string, string>)["x-portkey-config"]).toBe("test-config");
  });

  it("never includes redacted lead data verbatim in a way that loses fields", async () => {
    fetchMock.mockResolvedValue(respondWithContent(JSON.stringify({ label: "Warm", confidence: 0.5, reason: "Some interest" })));
    await classifyLead(input);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(body.messages[1].content).toContain("50 lakh");
    expect(body.messages[1].content).toContain("Spring Sale");
  });

  it("throws a retryable error on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(new Response("error", { status: 503 }));
    await expect(classifyLead(input)).rejects.toMatchObject({ retryable: true, code: "AI_GATEWAY_HTTP_503" });
  });

  it("throws a retryable error when the response body is not valid JSON", async () => {
    fetchMock.mockResolvedValue(respondWithContent("not json"));
    await expect(classifyLead(input)).rejects.toMatchObject({ retryable: true, code: "AI_RESPONSE_NOT_JSON" });
  });

  it.each([
    ["a lowercase label", { label: "hot", confidence: 0.8, reason: "x" }, { label: "Hot", confidence: 0.8 }],
    ["an upper-case, padded label", { label: " WARM ", confidence: 0.5, reason: "x" }, { label: "Warm", confidence: 0.5 }],
    ["a confidence sent as a string", { label: "Cold", confidence: "0.7", reason: "x" }, { label: "Cold", confidence: 0.7 }],
  ])("accepts %s", async (_case, reply, expected) => {
    fetchMock.mockResolvedValue(respondWithContent(JSON.stringify(reply)));
    await expect(classifyLead(input)).resolves.toMatchObject(expected);
  });

  it("extracts the JSON object when the model adds text around it", async () => {
    fetchMock.mockResolvedValue(respondWithContent('Here is the result: {"label": "Hot", "confidence": 0.9, "reason": "Ready"} Hope this helps.'));
    await expect(classifyLead(input)).resolves.toEqual({ label: "Hot", confidence: 0.9, reason: "Ready" });
  });

  it.each([
    ["a non-numeric confidence string", { label: "Hot", confidence: "high", reason: "x" }],
    ["an empty confidence string", { label: "Hot", confidence: "", reason: "x" }],
    ["a label outside Hot/Warm/Cold", { label: "Not Interested", confidence: 0.9, reason: "x" }],
  ])("still rejects %s", async (_case, reply) => {
    fetchMock.mockResolvedValue(respondWithContent(JSON.stringify(reply)));
    await expect(classifyLead(input)).rejects.toMatchObject({ retryable: true, code: "AI_RESPONSE_SCHEMA_INVALID" });
  });

  it("throws a retryable error when the JSON does not match the expected schema (belt-and-suspenders against a guardrail misconfiguration)", async () => {
    fetchMock.mockImplementation(() => respondWithContent(JSON.stringify({ label: "Very Hot", confidence: 2, reason: "x" })));
    const error = await classifyLead(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiClassificationError);
    expect(error).toMatchObject({ retryable: true, code: "AI_RESPONSE_SCHEMA_INVALID" });
  });

  it("throws a retryable error when the network call itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(classifyLead(input)).rejects.toMatchObject({ retryable: true, code: "AI_NETWORK_FAILURE" });
  });
});
