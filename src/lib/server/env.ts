import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/server/app-error";

const isProduction = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// Supabase
//
// SUPABASE_PUBLISHABLE_KEY is deliberately not NEXT_PUBLIC_-prefixed: the
// browser never talks to Supabase directly (login_system_plan.md section
// 10 — the OTP-send request must pass through a protected Next.js server
// route), so this key stays server-side and is used only by the
// cookie-bound auth client in src/lib/server/auth/supabase-auth-client.ts.
// ---------------------------------------------------------------------------
const supabaseEnvironmentSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
});

export type SupabaseEnvironment = z.infer<typeof supabaseEnvironmentSchema>;

let cachedSupabaseEnvironment: SupabaseEnvironment | undefined;

export function getSupabaseEnv(): SupabaseEnvironment {
  if (cachedSupabaseEnvironment) {
    return cachedSupabaseEnvironment;
  }

  const result = supabaseEnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    throw new AppError("Supabase server configuration is incomplete.", {
      status: 503,
      code: "SUPABASE_CONFIGURATION_ERROR",
    });
  }

  cachedSupabaseEnvironment = result.data;
  return cachedSupabaseEnvironment;
}

// ---------------------------------------------------------------------------
// Auth (OTP identifier hashing, Turnstile CAPTCHA, Upstash rate limiting,
// subscription-reconciliation cron secret).
//
// Turnstile and Upstash variables are optional in the schema so login can
// be exercised in development without either account provisioned; in
// production both are mandatory and getAuthEnv() fails closed if either is
// missing. Callers must check isTurnstileConfigured() / isUpstashConfigured()
// before treating a call as protected in non-production environments.
// ---------------------------------------------------------------------------
// An unset optional var is `undefined`, but a `.env` file that declares a
// key with no value (KEY=, as this project's own .env.example does for
// every var, required and optional alike) sets it to an empty string, not
// undefined — and Zod's `.optional()` only treats a literal `undefined` as
// absent. Without this preprocessing, a real deployment or local .env.local
// that copies .env.example's blank-value convention and leaves Turnstile/
// Upstash unset would fail this schema outright instead of falling through
// to the intended dev-bypass path.
function emptyStringToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

const authEnvironmentSchema = z.object({
  OTP_IDENTIFIER_HMAC_SECRET: z.string().min(32),
  SUBSCRIPTION_CRON_SECRET: z.string().min(32),
  TURNSTILE_SECRET_KEY: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  UPSTASH_REDIS_REST_URL: z.preprocess(emptyStringToUndefined, z.url().optional()),
  UPSTASH_REDIS_REST_TOKEN: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
});

export type AuthEnvironment = z.infer<typeof authEnvironmentSchema>;

let cachedAuthEnvironment: AuthEnvironment | undefined;

export function getAuthEnv(): AuthEnvironment {
  if (cachedAuthEnvironment) {
    return cachedAuthEnvironment;
  }

  const result = authEnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    throw new AppError("Auth server configuration is incomplete.", {
      status: 503,
      code: "AUTH_CONFIGURATION_ERROR",
    });
  }

  if (isProduction && !hasTurnstileCredentials(result.data)) {
    throw new AppError("Turnstile CAPTCHA protection is required in production.", {
      status: 503,
      code: "TURNSTILE_CONFIGURATION_ERROR",
    });
  }

  if (isProduction && !hasUpstashCredentials(result.data)) {
    throw new AppError("Upstash Redis rate limiting is required in production.", {
      status: 503,
      code: "UPSTASH_CONFIGURATION_ERROR",
    });
  }

  cachedAuthEnvironment = result.data;
  return cachedAuthEnvironment;
}

function hasTurnstileCredentials(environment: AuthEnvironment): boolean {
  return Boolean(environment.TURNSTILE_SECRET_KEY && environment.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
}

function hasUpstashCredentials(environment: AuthEnvironment): boolean {
  return Boolean(environment.UPSTASH_REDIS_REST_URL && environment.UPSTASH_REDIS_REST_TOKEN);
}

/** True when Turnstile is configured for the current environment (always true in production, since getAuthEnv() would already have thrown otherwise). */
export function isTurnstileConfigured(): boolean {
  return hasTurnstileCredentials(getAuthEnv());
}

/** True when Upstash Redis is configured for the current environment (always true in production, since getAuthEnv() would already have thrown otherwise). */
export function isUpstashConfigured(): boolean {
  return hasUpstashCredentials(getAuthEnv());
}

// ---------------------------------------------------------------------------
// Meta (Facebook Graph API / Lead Ads)
// ---------------------------------------------------------------------------
const metaEnvironmentSchema = z.object({
  NEXT_PUBLIC_META_APP_ID: z.string().min(1),
  NEXT_PUBLIC_META_LOGIN_CONFIG_ID: z.string().min(1),
  NEXT_PUBLIC_META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/),
  META_TOKEN_ENCRYPTION_KEY: z.string().min(1),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(32),
  META_WEBHOOK_CALLBACK_URL: z.url().refine((value) => new URL(value).protocol === "https:", {
    message: "META_WEBHOOK_CALLBACK_URL must use HTTPS.",
  }),
});

export type MetaEnvironment = z.infer<typeof metaEnvironmentSchema>;

let cachedMetaEnvironment: MetaEnvironment | undefined;

export function getMetaEnv(): MetaEnvironment {
  if (cachedMetaEnvironment) {
    return cachedMetaEnvironment;
  }

  const result = metaEnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    throw new AppError("Meta server configuration is incomplete.", {
      status: 503,
      code: "META_CONFIGURATION_ERROR",
    });
  }

  if (
    result.data.NEXT_PUBLIC_META_APP_ID !== result.data.META_APP_ID ||
    result.data.NEXT_PUBLIC_META_GRAPH_API_VERSION !== result.data.META_GRAPH_API_VERSION
  ) {
    throw new AppError("Meta client and server configuration do not match.", {
      status: 503,
      code: "META_CONFIGURATION_MISMATCH",
    });
  }

  cachedMetaEnvironment = result.data;
  return cachedMetaEnvironment;
}

export function getTokenEncryptionKey(): Buffer {
  const encodedKey = getMetaEnv().META_TOKEN_ENCRYPTION_KEY;
  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32) {
    throw new AppError("Token encryption is not configured correctly.", {
      status: 503,
      code: "TOKEN_ENCRYPTION_CONFIGURATION_ERROR",
    });
  }

  return key;
}

// ---------------------------------------------------------------------------
// QStash (async job queue)
// ---------------------------------------------------------------------------
const qstashEnvironmentSchema = z.object({
  QSTASH_TOKEN: z.string().min(1),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1),
});

export type QstashEnvironment = z.infer<typeof qstashEnvironmentSchema>;

let cachedQstashEnvironment: QstashEnvironment | undefined;

export function getQstashEnv(): QstashEnvironment {
  if (cachedQstashEnvironment) {
    return cachedQstashEnvironment;
  }

  const result = qstashEnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    throw new AppError("QStash server configuration is incomplete.", {
      status: 503,
      code: "QSTASH_CONFIGURATION_ERROR",
    });
  }

  cachedQstashEnvironment = result.data;
  return cachedQstashEnvironment;
}
