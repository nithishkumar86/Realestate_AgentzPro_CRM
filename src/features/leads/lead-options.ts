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
  // Appended last on purpose: the dashboard colours each status by its position (--status-N).
  "Asking Time for Taking Decision",
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

// The only statuses the leads table colours, so a telecaller spots them at a glance. Every other status stays plain.
// The drawer's status banner uses the same colours for these three. UI-only rule.
export const STATUS_HIGHLIGHTS = {
  "Details send via WhatsApp": "green",
  Disqualified: "red",
  "Didn't pick the call": "pink",
} as const satisfies Partial<Record<LeadStatus, string>>;

export type StatusHighlight = (typeof STATUS_HIGHLIGHTS)[keyof typeof STATUS_HIGHLIGHTS];

export function statusHighlight(status: LeadStatus): StatusHighlight | undefined {
  return (STATUS_HIGHLIGHTS as Partial<Record<LeadStatus, StatusHighlight>>)[status];
}

// The status every lead starts with. While a lead is still on it nobody has recorded the outcome of a first
// call, so the follow-up task cannot be created yet: the telecaller updates the status first (step 1), then
// adds the task (step 2), then the note (step 3). The server enforces this; the drawer shows it.
export const INITIAL_LEAD_STATUS = "New Lead" satisfies LeadStatus;

export function isTaskCreationLocked(status: LeadStatus): boolean {
  return status === INITIAL_LEAD_STATUS;
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
  "lead_assigned",
] as const;

export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];

export const TIMELINE_FILTERS = ["all", "status", "notes", "tasks"] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

/** The activity types each timeline tab shows. "all" is every type. */
export const TIMELINE_FILTER_TYPES: Record<Exclude<TimelineFilter, "all">, readonly LeadActivityType[]> = {
  status: ["lead_created", "status_change", "lead_assigned"],
  notes: ["note_added"],
  tasks: ["task_created", "task_rescheduled", "task_completed", "task_cancelled"],
};

// Where a lead came from. Keep in sync with the `lead_data.lead_source` check constraint in
// supabase/migrations/20261028120000_google_ads_leads.sql.
export const LEAD_SOURCES = ["facebook", "telecaller", "google_ads"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = { facebook: "Facebook", telecaller: "Telecaller", google_ads: "Google Ads" };

// Where a call-in lead can say it came from: every lead platform except Telecaller (that is how it entered, not where
// the person came from). Keep in sync with call_in_platforms() and lead_data_came_from_check in
// supabase/migrations/20261030120000_call_in_lead_came_from.sql.
export type CallInPlatform = Exclude<LeadSource, "telecaller">;
export const CALL_IN_PLATFORMS = LEAD_SOURCES.filter((source): source is CallInPlatform => source !== "telecaller");
/** What a call-in lead is credited to on each platform: a Facebook ad, a Google Ads campaign. */
export const CALL_IN_REF_LABELS: Record<CallInPlatform, string> = { facebook: "Ad", google_ads: "Campaign" };

// Call-in lead form limits; the create_telecaller_lead RPC enforces the same.
export const CALL_IN_TEXT_MAX_LENGTH = 200;
export const CALL_IN_PHONE_MAX_LENGTH = 30;
export const CALL_IN_PHONE_MIN_DIGITS = 10;

// The Leads page "Assignee" filter: one of these two shortcuts, or a member's user id.
export const ASSIGNEE_FILTER_SHORTCUTS = ["me", "unassigned"] as const;

export const NOTE_MAX_LENGTH = 2000;
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 2000;

/** Ready-made task titles for the Add Task form. The chosen text is saved as the plain title, so nothing server-side depends on this list. */
export const TASK_TITLE_PRESETS = [
  "Call Back",
  "Send WhatsApp",
  "Follow Up",
  "Send Brochure",
  "Send Price List",
  "Site Visit",
] as const;

/** Select value for "Other (type your own)". Not a title, so it can never collide with a preset or be saved by accident. */
export const TASK_TITLE_OTHER = "__other__";

// Task repeat rules. Keep in sync with the `lead_tasks.repeat_rule` check constraint in
// supabase/migrations/20261007120000_lead_task_due_time_repeat.sql.
export const TASK_REPEAT_RULES = ["none", "daily", "weekly", "monthly", "yearly"] as const;
export type TaskRepeatRule = (typeof TASK_REPEAT_RULES)[number];

/** The "Select Repeat this Task" options, in the order and wording the form shows. */
export const TASK_REPEAT_OPTIONS: ReadonlyArray<{ value: TaskRepeatRule; label: string }> = [
  { value: "daily", label: "Everyday" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "none", label: "Don't Repeat" },
];

export const DUE_DATE_PRESETS = ["today", "tomorrow", "3_days", "1_week", "1_month", "custom"] as const;
export type DueDatePreset = (typeof DUE_DATE_PRESETS)[number];

/** The "Due Date" options, in the order and wording the form shows. */
export const DUE_DATE_PRESET_OPTIONS: ReadonlyArray<{ value: DueDatePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "3_days", label: "3 Days From Now" },
  { value: "1_week", label: "1 Week From Now" },
  { value: "1_month", label: "1 Month From Now" },
  { value: "custom", label: "Custom" },
];
