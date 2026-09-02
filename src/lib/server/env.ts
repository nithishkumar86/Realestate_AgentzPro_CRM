import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/server/app-error";

const serverEnvironmentSchema = z.object({
  NEXT_PUBLIC_META_APP_ID: z.string().min(1),
  NEXT_PUBLIC_META_LOGIN_CONFIG_ID: z.string().min(1),
  NEXT_PUBLIC_META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/),
  META_TOKEN_ENCRYPTION_KEY: z.string().min(1),
  META_TEST_TENANT_ID: z.uuid(),
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

let cachedServerEnvironment: ServerEnvironment | undefined;

export function getServerEnvironment(): ServerEnvironment {
  if (cachedServerEnvironment) {
    return cachedServerEnvironment;
  }

  const result = serverEnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    throw new AppError("Server configuration is incomplete.", {
      status: 503,
      code: "SERVER_CONFIGURATION_ERROR",
    });
  }

  if (result.data.NEXT_PUBLIC_META_APP_ID !== result.data.META_APP_ID || result.data.NEXT_PUBLIC_META_GRAPH_API_VERSION !== result.data.META_GRAPH_API_VERSION) {
    throw new AppError("Meta client and server configuration do not match.", {
      status: 503,
      code: "META_CONFIGURATION_MISMATCH",
    });
  }

  cachedServerEnvironment = result.data;
  return cachedServerEnvironment;
}

export function getTokenEncryptionKey(): Buffer {
  const encodedKey = getServerEnvironment().META_TOKEN_ENCRYPTION_KEY;
  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32) {
    throw new AppError("Token encryption is not configured correctly.", {
      status: 503,
      code: "TOKEN_ENCRYPTION_CONFIGURATION_ERROR",
    });
  }

  return key;
}
