import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/server/app-error";

// Separate from env.ts deliberately: the label-classification pipeline is
// entirely additive, and this keeps it from touching the existing env
// schemas at all. PORTKEY_CONFIG_ID points at a config the user builds and
// maintains directly in the Portkey dashboard (model fallback, timeout,
// retry, the output JSON-schema guardrail) — nothing about model choice or
// retry policy is configured here.
const aiEnvironmentSchema = z.object({
  PORTKEY_API_KEY: z.string().min(1),
  PORTKEY_CONFIG_ID: z.string().min(1),
});

export type AiEnvironment = z.infer<typeof aiEnvironmentSchema>;

let cachedAiEnvironment: AiEnvironment | undefined;

export function getAiEnv(): AiEnvironment {
  if (cachedAiEnvironment) {
    return cachedAiEnvironment;
  }

  const result = aiEnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    throw new AppError("AI classification server configuration is incomplete.", {
      status: 503,
      code: "AI_CONFIGURATION_ERROR",
    });
  }

  cachedAiEnvironment = result.data;
  return cachedAiEnvironment;
}
