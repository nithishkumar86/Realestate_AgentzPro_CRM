export type ConnectionStatus = "active" | "reauthorization_required" | "disconnected";

export interface FacebookPageConnection {
  id: string;
  connectionId: string;
  pageName: string;
  category: string | null;
  pageIdLastFour: string;
  status: ConnectionStatus;
  lastConnectedAt: string;
}

export interface ConnectionOverview {
  connectionStatus: ConnectionStatus | "not_connected";
  pages: FacebookPageConnection[];
}

export interface EligibleFacebookPage {
  facebookPageId: string;
  facebookPageName: string;
  assignedTasks: string[];
  pageIdLastFour: string;
  /**
   * Page access this integration still needs before the Page can be connected. Empty means connectable.
   * Reported rather than the Page being hidden, so "my Page isn't listed" becomes "you need MANAGE on it".
   */
  missingTasks: string[];
}

export type ConnectionAction = "connect" | "reconnect" | "disconnect";

export interface ServiceResult<T> {
  data: T;
}

export interface LeadField {
  key: string;
  values: string[];
}

export interface Lead {
  id: string;
  fullName: string | null;
  phoneNumber: string | null;
  emailAddress: string | null;
  facebookPageName: string;
  receivedAt: string;
  fields: LeadField[];
}

export type LeadView = "today" | "month" | "all";
export type DateFilter = "today" | "week" | "month" | "custom" | null;

export interface LeadQuery {
  view: LeadView;
  search: string;
  dateFilter: DateFilter;
  customStartDate: string | null;
  customEndDate: string | null;
  page: number;
  pageSize: number;
}

export interface PaginatedLeads {
  items: Lead[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface LeadCounts {
  today: number;
  month: number;
  all: number;
}

export interface DashboardData {
  counts: LeadCounts;
  monthlyTotals: Array<{ month: string; count: number; isCurrent: boolean }>;
  pageDistribution: Array<{ pageName: string; count: number }>;
}

export interface UserProfileFields {
  fullName: string;
  emailAddress: string;
  phoneNumber: string;
  roleTitle: string;
}

export interface CompanyFields {
  companyName: string;
  businessType: string;
  primaryMarket: string;
  website: string;
}

export interface SubscriptionFields {
  planName: string;
  status: string;
  renewalNote: string;
}

export interface SettingsData {
  profile: UserProfileFields;
  company: CompanyFields;
  subscription: SubscriptionFields;
}
