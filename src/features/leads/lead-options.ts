// Single source of truth for the lead triage vocabulary shared by the client UI,
// the API route validators, and the query service. Keep in sync with the
// `lead_data.status` / `lead_data.label` check constraints in supabase/migrations.
export const LEAD_STATUSES = [
  "New Lead",
  "Not reachable",
  "Working",
  "Closed",
  "Archived",
  "Sale",
  "Site visit done",
  "Next project",
  "Site visit pending",
  "Final call",
  "Didn't pick the call",
  "Details send via WhatsApp",
  "Disqualified",
] as const;

export const LEAD_LABELS = ["Hot", "Warm", "Cold", "Not Interested"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadLabel = (typeof LEAD_LABELS)[number];
