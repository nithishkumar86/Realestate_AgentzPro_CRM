import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/server/app-error";
import { getRazorpayEnv } from "@/lib/server/env";

/**
 * Minimal Razorpay REST client for subscriptions. Plain fetch with Basic auth
 * (`key_id:key_secret`), no SDK — the same approach as meta-client.ts.
 *
 * Endpoints (razorpay.com/docs/api/payments/subscriptions/ and …/invoices/):
 *   POST /v1/subscriptions               create
 *   GET  /v1/subscriptions/{id}          fetch
 *   POST /v1/subscriptions/{id}/cancel   cancel (cancel_at_cycle_end)
 *   GET  /v1/invoices/{id}               fetch invoice (carries subscription_id)
 *
 * Every response is validated with zod: a shape we do not understand is an error, never a guess.
 * Errors carry `retryable`: true for network failures, timeouts, 429 and 5xx (a retry may succeed),
 * false for other 4xx (a retry will fail the same way). The webhook uses this to decide whether to ask
 * Razorpay to redeliver.
 */

const RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;

export const RAZORPAY_SUBSCRIPTION_STATUSES = [
  "created",
  "authenticated",
  "active",
  "pending",
  "halted",
  "cancelled",
  "completed",
  "expired",
  "paused",
] as const;

export type RazorpaySubscriptionStatus = (typeof RAZORPAY_SUBSCRIPTION_STATUSES)[number];

// Razorpay returns `notes` as an empty ARRAY when there are none, and as an object otherwise.
const notesSchema = z
  .union([z.record(z.string(), z.union([z.string(), z.number()])), z.array(z.unknown()).length(0)])
  .transform((value): Record<string, string> =>
    Array.isArray(value) ? {} : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)])),
  );

const subscriptionSchema = z.object({
  id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
  plan_id: z.string(),
  status: z.enum(RAZORPAY_SUBSCRIPTION_STATUSES),
  quantity: z.number().int().positive(),
  current_start: z.number().int().nullable(),
  current_end: z.number().int().nullable(),
  charge_at: z.number().int().nullable().optional(),
  notes: notesSchema.optional().default({}),
});

export type RazorpaySubscription = z.infer<typeof subscriptionSchema>;

const invoiceSchema = z.object({
  id: z.string().regex(/^inv_[A-Za-z0-9]+$/),
  subscription_id: z.string().nullable().optional(),
  payment_id: z.string().nullable().optional(),
  status: z.string(),
  billing_start: z.number().int().nullable().optional(),
  billing_end: z.number().int().nullable().optional(),
  short_url: z.string().nullable().optional(),
});

export type RazorpayInvoice = z.infer<typeof invoiceSchema>;

const errorBodySchema = z.object({
  error: z.object({ code: z.string().optional(), description: z.string().optional() }).optional(),
});

export interface CreateSubscriptionInput {
  planId: string;
  quantity: number;
  totalCount: number;
  /** Unix seconds: the customer must complete the first (authorisation) payment before this. */
  expireBy: number;
  notes: Record<string, string>;
}

type FetchImplementation = typeof fetch;

export class RazorpayClient {
  private readonly authorization: string;
  private readonly fetchImplementation: FetchImplementation;

  public constructor(options: { keyId: string; keySecret: string; fetchImplementation?: FetchImplementation }) {
    this.authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`, "utf8").toString("base64")}`;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async createSubscription(input: CreateSubscriptionInput): Promise<RazorpaySubscription> {
    const body = await this.request("POST", "/subscriptions", {
      plan_id: input.planId,
      quantity: input.quantity,
      total_count: input.totalCount,
      expire_by: input.expireBy,
      // We show our own "Activating…" screen and receipts; Razorpay still emails payment confirmations.
      customer_notify: true,
      notes: input.notes,
    });
    return parseResponse(subscriptionSchema, body, "subscription");
  }

  public async fetchSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
    const body = await this.request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return parseResponse(subscriptionSchema, body, "subscription");
  }

  public async cancelSubscription(subscriptionId: string, options: { atCycleEnd: boolean }): Promise<RazorpaySubscription> {
    const body = await this.request("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      cancel_at_cycle_end: options.atCycleEnd,
    });
    return parseResponse(subscriptionSchema, body, "subscription");
  }

  public async fetchInvoice(invoiceId: string): Promise<RazorpayInvoice> {
    const body = await this.request("GET", `/invoices/${encodeURIComponent(invoiceId)}`);
    return parseResponse(invoiceSchema, body, "invoice");
  }

  private async request(method: "GET" | "POST", path: string, jsonBody?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImplementation(`${RAZORPAY_API_BASE_URL}${path}`, {
        method,
        headers: {
          authorization: this.authorization,
          accept: "application/json",
          ...(jsonBody === undefined ? {} : { "content-type": "application/json" }),
        },
        body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      throw new AppError("Razorpay could not be reached.", {
        status: 502,
        code: "RAZORPAY_UNAVAILABLE",
        retryable: true,
        details: { reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "network" },
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const parsedError = errorBodySchema.safeParse(payload);
      const razorpayCode = parsedError.success ? parsedError.data.error?.code : undefined;
      const retryable = response.status === 429 || response.status >= 500;
      // The description is Razorpay's text; it goes to logs via AppError.details, never to the browser
      // as a message of ours.
      throw new AppError("Razorpay rejected the request.", {
        status: retryable ? 502 : 400,
        code: "RAZORPAY_REQUEST_FAILED",
        retryable,
        details: {
          httpStatus: response.status,
          ...(razorpayCode ? { razorpayCode } : {}),
        },
      });
    }

    return payload;
  }
}

function parseResponse<T>(schema: z.ZodType<T>, payload: unknown, entity: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError("Razorpay returned an unexpected response.", {
      status: 502,
      code: "RAZORPAY_UNEXPECTED_RESPONSE",
      retryable: false,
      details: { entity },
    });
  }
  return parsed.data;
}

let razorpayClient: RazorpayClient | undefined;

export function getRazorpayClient(): RazorpayClient {
  if (!razorpayClient) {
    const environment = getRazorpayEnv();
    razorpayClient = new RazorpayClient({ keyId: environment.RAZORPAY_KEY_ID, keySecret: environment.RAZORPAY_KEY_SECRET });
  }
  return razorpayClient;
}

/** Razorpay timestamps are Unix seconds; the database stores timestamptz. */
export function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
