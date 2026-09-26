export interface CheckoutSession {
  subscriptionId: string;
  keyId: string;
  planName: string;
  seats: number;
  amountPaise: number;
  companyName: string;
}

export interface BillingStatus {
  subscriptionStatus: string;
  currentPeriodEndsAt: string | null;
  hasCrmAccess: boolean;
}

type ApiErrorPayload = { error?: { message?: string } };

async function readJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error((payload as ApiErrorPayload | null)?.error?.message ?? fallbackMessage);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error(fallbackMessage);
  }
  return payload as T;
}

export async function startCheckout(planCode: string, seats: number): Promise<CheckoutSession> {
  const response = await fetch("/api/billing/checkout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ planCode, seats }),
  });
  return readJson<CheckoutSession>(response, "Checkout could not be started.");
}

export async function getBillingStatus(signal?: AbortSignal): Promise<BillingStatus> {
  const response = await fetch("/api/billing/status", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  return readJson<BillingStatus>(response, "Billing status could not be loaded.");
}

export async function cancelSubscriptionAtPeriodEnd(): Promise<{ periodEndsAt: string | null }> {
  const response = await fetch("/api/billing/cancel", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  return readJson<{ periodEndsAt: string | null }>(response, "The subscription could not be cancelled.");
}

export interface BillingInvoice {
  paymentId: string;
  amountPaise: number;
  currency: string;
  paymentMethod: string | null;
  periodStart: string;
  periodEnd: string;
  paidAt: string;
  invoiceUrl: string | null;
}

export async function getInvoices(signal?: AbortSignal): Promise<BillingInvoice[]> {
  const response = await fetch("/api/billing/invoices", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  const payload = await readJson<{ invoices?: unknown }>(response, "Invoices could not be loaded.");
  if (!Array.isArray(payload.invoices)) {
    throw new Error("The invoices response was invalid.");
  }
  return payload.invoices as BillingInvoice[];
}
