# Real Estate CRM — MVP Spec

## Lead Status List

| # | Status | Definition |
|---|--------|------------|
| 1 | 🔴 New Lead | Lead just entered the system, no contact made yet |
| 2 | 🟡 Working | Actively following up, conversation is ongoing |
| 3 | 🟠 Didn't Pick the Call | Called but no response, waiting to retry |
| 4 | 🔵 Details Sent via WhatsApp | Project details shared, waiting for lead's response |
| 5 | 🟡 Discussion | Lead is interested but discussing with family before deciding |
| 6 | 🟢 Site Visit Pending | Site visit agreed upon, date not yet confirmed or upcoming |
| 7 | 🟢 Site Visit Done | Lead has visited the site, follow-up in progress |
| 8 | 🟡 Negotiation | Lead is interested, price or terms being discussed |
| 9 | 🟢 Sale | Deal confirmed, booking amount received |
| 10 | 🔵 Closed | Construction started, all formalities complete |
| 11 | 🔴 Disqualified | Lead doesn't match budget, location, or requirement |
| 12 | 🔴 Lost | Was a valid lead but chose a competitor or dropped out |

> Note: Status 11 and 12 can happen at any stage of the pipeline, not just the end.

---

## Lead Labels

### Fixed (MVP defaults — always present)

| Label | Meaning |
|-------|---------|
| 🔴 Hot | Ready to buy, high intent |
| 🟡 Warm | Interested but not urgent |
| 🔵 Cold | Low engagement, long term |
| ⚪ Not Interested | Explicitly said no |

### Dynamic (admin creates from settings)
- Project-specific labels (e.g. BRIQ Aastha, JV Construction)
- Admin adds from settings panel → appears in the same label list

---

## Leads Table — MVP Columns

| Client Name | Phone | Source | Status | Label | Project | Date | View |
|-------------|-------|--------|--------|-------|---------|------|------|

- **Source** — where the lead came from (Facebook, LeadForm, etc.)
- **Status** — colored pill from the status list above
- **Label** — Hot / Warm / Cold / Not Interested
- **Project** — which property the lead belongs to (BRIQ Aastha, JV Construction, etc.)
- **View** — button that opens the right side panel with full lead details

---

## Overall Layout

```
┌─────────────┬──────────────────────────────┬─────────────────┐
│ Left        │ Main Content                 │ Right Panel     │
│ Sidebar     │ (Leads Table)                │ (on View click) │
│             │                              │                 │
│ 📋 Leads    │ [Search] [Status] [Label]    │ Full lead info  │
│ 📊 Dashboard│ [Date filter]                │ Editable fields │
│ 🔗 Connection│                             │ Notes / history │
│             │ Table with columns above     │                 │
└─────────────┴──────────────────────────────┴─────────────────┘
```

### Left Sidebar Navigation
- Leads
- Dashboard
- Connection

### Top Filters (Leads page)
- Search (name, phone, email)
- Filter by Status
- Filter by Label
- Date filter

### Right Side Panel (on View click)
- Name, Phone, Email
- Source
- Status (editable dropdown)
- Label (editable)
- Project (editable)
- Assigned To
- Date
- Notes / conversation history

---

## Pipeline Flow

```
New Lead → Working → Didn't Pick the Call
                  → Details Sent via WhatsApp
                  → Discussion
                  → Site Visit Pending → Site Visit Done → Negotiation → Sale → Closed

At any stage → Disqualified / Lost
```
