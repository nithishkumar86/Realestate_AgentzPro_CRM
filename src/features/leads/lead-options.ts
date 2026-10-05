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

// Statuses that end a lead's pipeline. A lead in one of these needs no follow-up, so the leads table hides
// its "no open task" marker, and moving a lead into one offers to cancel its open task. UI-only rule.
export const FINAL_LEAD_STATUSES = ["Sale", "Closed", "Disqualified", "Archived"] as const satisfies readonly LeadStatus[];

export function isFinalLeadStatus(status: LeadStatus): boolean {
  return (FINAL_LEAD_STATUSES as readonly LeadStatus[]).includes(status);
}

// Lead Timeline vocabulary. Keep in sync with the `lead_activities.type` check constraint in
// supabase/migrations/20261005120000_lead_notes_tasks_timeline.sql.
export const LEAD_ACTIVITY_TYPES = [
  "lead_created",
  "status_change",
  "note_added",
  "task_created",
  "task_rescheduled",
  "task_completed",
  "task_cancelled",
] as const;

export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];

export const TIMELINE_FILTERS = ["all", "status", "notes", "tasks"] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

/** The activity types each timeline tab shows. "all" is every type. */
export const TIMELINE_FILTER_TYPES: Record<Exclude<TimelineFilter, "all">, readonly LeadActivityType[]> = {
  status: ["lead_created", "status_change"],
  notes: ["note_added"],
  tasks: ["task_created", "task_rescheduled", "task_completed", "task_cancelled"],
};

export const NOTE_MAX_LENGTH = 2000;
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 2000;
