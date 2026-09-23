-- MVP: drop the 'admin' membership role. Existing admins become employees, and
-- membership_role is restricted to 'owner' and 'employee' going forward.
begin;

update public.tenant_memberships
set membership_role = 'employee'
where membership_role = 'admin';

alter table public.tenant_memberships drop constraint tenant_memberships_membership_role_check;
alter table public.tenant_memberships add constraint tenant_memberships_membership_role_check
    check (membership_role in ('owner', 'employee'));

commit;
