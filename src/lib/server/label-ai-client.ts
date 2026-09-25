import "server-only";

import { z } from "zod";
import { getAiEnv } from "@/lib/server/ai-env";
import type { LeadField } from "@/lib/server/lead-redaction";

const PORTKEY_CHAT_COMPLETIONS_URL = "https://api.portkey.ai/v1/chat/completions";
// Backstop only. The user's Portkey config carries its own per-target
// request_timeout (set manually in the Portkey dashboard, see the pipeline
// plan's Step 0); this just bounds the whole call, including whatever
// fallback/retry chain Portkey runs underneath, from this process's side.
const REQUEST_TIMEOUT_MS = 20_000;

const LEAD_LABEL_VALUES = ["Hot", "Warm", "Cold"] as const;

const classificationResponseSchema = z.object({
  label: z.enum(LEAD_LABEL_VALUES),
  confidence: z.number().min(0).max(1),
  // Cut rather than rejected: an over-long reason shouldn't fail an otherwise valid label.
  reason: z.string().transform((reason) => reason.slice(0, 200)),
});

export type LeadClassification = z.infer<typeof classificationResponseSchema>;

/**
 * Belt-and-suspenders alongside the Portkey output guardrail: the guardrail
 * is configured (manually, in Portkey) to deny a malformed response before
 * it ever reaches this process, but this client never trusts that as the
 * only line of defence — every response is independently re-validated here.
 */
export class AiClassificationError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(message: string, options: { code: string; retryable: boolean }) {
    super(message);
    this.name = "AiClassificationError";
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export type LeadClassificationInput = {
  /** Already redacted by redactLeadFieldsForAi — this client never sees raw PII. */
  redactedFields: LeadField[];
  adName: string | null;
  status: string;
};

const SYSTEM_PROMPT = [
  "You are a sales lead classifier for a CRM. Classify each lead's purchase intent from its form",
  'answers into exactly one of: Hot, Warm, Cold. Names, emails and phone numbers',
  "have already been removed and replaced with placeholders such as [NAME], [EMAIL], [PHONE] -",
  "ignore those placeholders, they carry no signal.",
  "Score the lead out of 100 using this reference guide. Form questions differ per ad, so match",
  "answers by meaning, not exact field name, and give partial marks for partial matches:",
  "(1) Buying timeline - within 1 month: 20 marks; later timelines get fewer.",
  "(2) Budget - near or above 1 Cr: 20 marks; lower budgets get fewer.",
  "(3) All documents ready: 20 marks.",
  "(4) All documents in the lead's own name: 20 marks.",
  "(5) No need to discuss with family: 10 marks.",
  "(6) Any other buying signal in the lead data (e.g. wants a site visit, clear location or",
  "property need): up to 10 marks.",
  "If a form did not ask about some of these factors, score only the factors it did ask and",
  "scale the total to 100. Label by the final score: 60 or above = Hot, 30 to 59 = Warm, below",
  "30 = Cold. Mention the score in the reason. Respond with strict JSON only, matching this",
  'shape: {"label": "Hot" | "Warm" | "Cold", "confidence": a number between 0',
  'and 1, "reason": a short reason under 200 characters}. Output only the raw JSON object:',
  "start with { and end with }. Do not use markdown, code fences or any text before or after it.",
  "Keep the reason under 200 characters.",
].join(" ");

export async function classifyLead(input: LeadClassificationInput): Promise<LeadClassification> {
  const environment = getAiEnv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(PORTKEY_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-portkey-api-key": environment.PORTKEY_API_KEY,
        "x-portkey-config": environment.PORTKEY_CONFIG_ID,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
        ],
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    throw new AiClassificationError("The classification request could not reach the AI gateway.", {
      code: error instanceof Error && error.name === "AbortError" ? "AI_REQUEST_TIMEOUT" : "AI_NETWORK_FAILURE",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new AiClassificationError(`The AI gateway returned HTTP ${response.status}.`, {
      code: `AI_GATEWAY_HTTP_${response.status}`,
      retryable: true,
    });
  }

  const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new AiClassificationError("The AI gateway response did not include a message.", { code: "AI_RESPONSE_MALFORMED", retryable: true });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(content));
  } catch {
    throw new AiClassificationError("The AI gateway response was not valid JSON.", { code: "AI_RESPONSE_NOT_JSON", retryable: true });
  }

  const result = classificationResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new AiClassificationError("The AI gateway response did not match the expected schema.", { code: "AI_RESPONSE_SCHEMA_INVALID", retryable: true });
  }

  return result.data;
}

/** Some models wrap their JSON in a ```json ... ``` markdown fence despite the prompt; unwrap it. */
function stripCodeFences(content: string): string {
  const fenced = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : content;
}

function buildUserPrompt(input: LeadClassificationInput): string {
  return JSON.stringify({ ad_name: input.adName, current_status: input.status, answers: input.redactedFields });
}
