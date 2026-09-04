-- Adds mutable CRM triage fields to lead_data so the leads UI can persist a
-- lead's status/label directly on the row, independent of the leads list
-- filters (which read the same columns but must never write them).
alter table public.lead_data
  add column if not exists status text not null default 'New Lead'
    check (status in (
      'New Lead', 'Not reachable', 'Working', 'Closed', 'Archived', 'Sale',
      'Site visit done', 'Next project', 'Site visit pending', 'Final call',
      'Didn''t pick the call', 'Details send via WhatsApp', 'Disqualified'
    )),
  add column if not exists label text not null default 'Warm'
    check (label in ('Hot', 'Warm', 'Cold', 'Not Interested'));

create trigger lead_data_set_updated_at before update on public.lead_data
  for each row execute function public.set_updated_at();
