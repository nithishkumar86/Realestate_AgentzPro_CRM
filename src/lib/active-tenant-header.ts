/**
 * Header a CRM page sends with every /api request: the company that page was rendered for.
 * The server rejects the request when it no longer matches the active company (another tab
 * switched it). Shared by the browser guard and the server check, so it lives outside server-only code.
 */
export const ACTIVE_TENANT_HEADER = "x-active-tenant";

/** Error code the server answers with when the claim and the active company differ. */
export const WORKSPACE_CHANGED_CODE = "WORKSPACE_CHANGED";
