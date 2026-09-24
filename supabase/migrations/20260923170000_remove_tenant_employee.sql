-- Owners may remove employees from their own tenant. Historical assignment audit rows retain the
-- actor's auth user id even after that person's tenant membership is removed.
begin;

do $$
declare
    membership_constraint text;
begin
    for membership_constraint in
        select constraint_record.conname
        from pg_constraint as constraint_record
        where constraint_record.conrelid = 'public.lead_project_assignment_audit'::regclass
          and constraint_record.confrelid = 'public.tenant_memberships'::regclass
          and constraint_record.contype = 'f'
    loop
        execute format(
            'alter table public.lead_project_assignment_audit drop constraint %I',
            membership_constraint
        );
    end loop;
end;
$$;

alter table public.lead_project_assignment_audit
    alter column changed_by_user_id drop not null;

alter table public.lead_project_assignment_audit
    add constraint lead_project_assignment_audit_changed_by_user_id_fkey
    foreign key (changed_by_user_id) references auth.users (id) on delete set null;

create or replace function public.remove_tenant_member(
    p_tenant_id uuid,
    p_owner_user_id uuid,
    p_member_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    removed_user_id uuid;
begin
    if not exists (
        select 1
        from public.tenant_memberships as owner_membership
        where owner_membership.tenant_id = p_tenant_id
          and owner_membership.user_id = p_owner_user_id
          and owner_membership.membership_role = 'owner'
          and owner_membership.membership_status = 'active'
    ) then
        raise exception 'Only the active tenant owner can remove members' using errcode = '42501';
    end if;

    delete from public.tenant_memberships as member_membership
    where member_membership.tenant_id = p_tenant_id
      and member_membership.user_id = p_member_user_id
      and member_membership.membership_role = 'employee'
    returning member_membership.user_id into removed_user_id;

    return removed_user_id is not null;
end;
$$;

revoke all on function public.remove_tenant_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_tenant_member(uuid, uuid, uuid) to service_role;

commit;
