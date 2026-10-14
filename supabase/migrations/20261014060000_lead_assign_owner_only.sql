begin;

-- Per-lead manual assignment (the "Assigned to" picker in the lead drawer) was open to any active
-- member, same as a status change. That no longer matches the product requirement: only the company
-- owner may assign or reassign a lead. The automatic ad-rule flow (assign_lead_from_ad_rule trigger,
-- set/apply_lead_ad_assignment_rule) was already owner-only and is unchanged.
--
-- assert_active_tenant_owner raises 42501 for a non-owner or inactive actor, which the service layer
-- (assignLead in lead-assignment-service.ts) already maps to a 403 LEAD_ASSIGN_FORBIDDEN response.
create or replace function public.assign_lead(
  p_tenant_id uuid, p_lead_id uuid, p_assignee_user_id uuid, p_actor_user_id uuid
)
returns table (lead_id uuid, lead_assignee_user_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_active_tenant_owner(p_tenant_id, p_actor_user_id);
  if p_assignee_user_id is not null and not exists (
    select 1 from public.tenant_memberships as m
    where m.tenant_id = p_tenant_id and m.user_id = p_assignee_user_id and m.membership_status = 'active'
  ) then
    raise exception 'The assignee must be an active member of this company' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('app.current_user_id', p_actor_user_id::text, true);
  return query
    with updated as (
      update public.lead_data as ld
      set assigned_user_id = p_assignee_user_id
      where ld.tenant_id = p_tenant_id and ld.id = p_lead_id
      returning ld.id, ld.assigned_user_id
    )
    select updated.id, updated.assigned_user_id from updated;
  perform pg_catalog.set_config('app.current_user_id', '', true);
end;
$$;

revoke all on function public.assign_lead(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_lead(uuid, uuid, uuid, uuid) to service_role;

commit;
