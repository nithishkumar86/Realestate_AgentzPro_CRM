import type { DashboardData, Lead, LeadCounts, LeadQuery, PaginatedLeads, SettingsData } from "@/lib/types";
import { type DateRange, formatCalendarDate, getCustomRange, getMonthRange, getTodayRange, getWeekRange } from "@/lib/date-utils";

export async function getLeadCounts(): Promise<LeadCounts> { return { today: 0, month: 0, all: 0 }; }

export async function getLeads(query: LeadQuery): Promise<PaginatedLeads> {
  return { items: [], total: 0, page: Math.max(query.page, 1), pageSize: Math.max(query.pageSize, 1), totalPages: 1 };
}

export async function getAllMatchingLeads(query: Omit<LeadQuery, "page" | "pageSize">): Promise<Lead[]> { void query; return []; }

export async function getLeadById(): Promise<Lead> { throw new Error("Lead details are not available."); }

export async function getDashboardData(): Promise<DashboardData> {
  const now = new Date();
  return {
    counts: await getLeadCounts(),
    monthlyTotals: Array.from({ length: 6 }, (_, index) => {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - index), 1));
      return { month: new Intl.DateTimeFormat("en-IN", { month: "short" }).format(date), count: 0, isCurrent: index === 5 };
    }),
    pageDistribution: [],
  };
}

export async function getSettingsData(): Promise<SettingsData> {
  return { profile: { fullName: "", emailAddress: "", phoneNumber: "", roleTitle: "" }, company: { companyName: "", businessType: "", primaryMarket: "", website: "" }, subscription: { planName: "", status: "", renewalNote: "" } };
}

export async function saveSettingsData(data: SettingsData): Promise<{ message: string; data: SettingsData }> {
  if (!data.profile.fullName.trim() || !data.company.companyName.trim()) throw new Error("Profile and company details are required.");
  return { message: "Settings will be available after the profile system is connected.", data };
}

export function getLeadDateRange(query: Omit<LeadQuery, "page" | "pageSize">): DateRange | null {
  if (query.view === "today" || query.dateFilter === "today") return getTodayRange();
  if (query.view === "month" || query.dateFilter === "month") return getMonthRange();
  if (query.dateFilter === "week") return getWeekRange();
  if (query.dateFilter === "custom") {
    if (!query.customStartDate || !query.customEndDate) throw new Error("Select a custom start and end date.");
    return getCustomRange(query.customStartDate, query.customEndDate);
  }
  return null;
}

export function exportLeadsToCsv(leads: Lead[]): string {
  const rows = [["Name", "Phone", "Email", "Facebook Page", "Received", "Answers"], ...leads.map((lead) => [lead.fullName ?? "", lead.phoneNumber ?? "", lead.emailAddress ?? "", lead.facebookPageName, formatCalendarDate(new Date(lead.receivedAt)), lead.fields.map((field) => `${field.key}: ${field.values.join("; ")}`).join(" | ")])];
  return rows.map((row) => row.map(escapeCsvValue).join(",")).join("\r\n");
}

function escapeCsvValue(value: string): string { return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }
