-- Member invitations: an owner invites a person by email into THEIR tenant with a chosen role.
--
-- The whole point of this pipeline is that an invited person joins the inviting company's existing
-- tenant — one tenant_id for the entire organization. So the invitee path never touches
-- public.tenants or public.tenants_subscriptions: accept_member_invitation() below writes only a
-- profiles row, a tenant_memberships row carrying the invitation's tenant_id and role, and the
-- invitation's own status. The role is taken from the invitation row the owner created, never from
-- the invitee's request.
--
-- Pipeline:
--   1. Owner submits email + role. The server (service role) calls create_member_invitation(),
--      which verifies the inviter is the tenant's active owner, that the email does not already
--      belong to any company, and that it has no other pending invitation, then records the row.
--   2. The server asks Supabase Auth to send the invite email (auth.admin.inviteUserByEmail), which
--      creates the invitee's auth.users row; that user_id is written back onto the invitation.
--   3. The invitee follows the link, is signed in, and completes a setup form with only their own
--      personal details. accept_member_invitation() adds them to the tenant with the owner's role.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.invitation_member (
    invitation_id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants (tenant_id) on delete cascade,
    -- Stored normalized so every lookup and the one-pending-per-email index compare like with like.
    email text not null
        check (email = lower(btrim(email)) and length(email) between 3 and 320 and position('@' in email) > 1),
    -- The invitee's auth.users id. Set as soon as Supabase Auth has created (or already had) the
    -- account; null only for the brief window between recording the row and sending the email.
    user_id uuid references auth.users (id) on delete cascade,
    -- Only one owner is permitted per tenant, so an invitation can never grant 'owner'.
    membership_role text not null check (membership_role in ('admin', 'employee')),
    status text not null default 'pending'
        check (status in ('pending', 'accepted', 'revoked', 'expired')),
    invited_by uuid not null,
    expires_at timestamptz not null default (now() + interval '7 days'),
    accepted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint invitation_member_accepted_at_matches_status
        check ((status = 'accepted') = (accepted_at is not null)),
    -- The inviter must be a member of the very tenant being invited into.
    constraint invitation_member_inviter_membership_fkey
        foreign key (tenant_id, invited_by)
        references public.tenant_memberships (tenant_id, user_id) on delete cascade
);

-- A person can hold at most one open invitation at a time, across all tenants: a user may belong
-- to only one company (tenant_memberships_user_id_key), so two open invitations would be two
-- conflicting answers to "which company does this person join".
create unique index invitation_member_one_pending_per_email_idx
    on public.invitation_member (email)
    where status = 'pending';

create index invitation_member_tenant_created_idx
    on public.invitation_member (tenant_id, created_at desc);

create index invitation_member_pending_user_idx
    on public.invitation_member (user_id)
    where status = 'pending';

create index invitation_member_invited_by_idx
    on public.invitation_member (tenant_id, invited_by);

create trigger set_invitation_member_updated_at
    before update on public.invitation_member
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: server-only table. No browser role can read or write it; every access goes
-- through the service-role client or the SECURITY DEFINER functions below.
-- ---------------------------------------------------------------------------
alter table public.invitation_member enable row level security;
alter table public.invitation_member force row level security;

revoke all on table public.invitation_member from public, anon, authenticated;
grant select, insert, update, delete on table public.invitation_member to service_role;

-- ---------------------------------------------------------------------------
-- create_member_invitation — service role only.
--
-- Called by the trusted backend after it has resolved the caller's tenant and user id from a
-- verified session; neither value ever comes from the request body. Returns a machine-readable
-- outcome instead of raising for the expected rejections so the route can report each email.
-- ---------------------------------------------------------------------------
create or replace function public.create_member_invitation(
    p_tenant_id uuid,
    p_invited_by uuid,
    p_email text,
    p_membership_role text
)
returns table (
    outcome text,
    invitation_id uuid,
    user_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_email text;
    v_existing_user_id uuid;
    v_invitation_id uuid;
begin
    v_email := lower(btrim(coalesce(p_email, '')));
    if length(v_email) < 3 or length(v_email) > 320 or position('@' in v_email) <= 1 then
        return query select 'INVALID_EMAIL'::text, null::uuid, null::uuid;
        return;
    end if;

    if p_membership_role is null or p_membership_role not in ('admin', 'employee') then
        return query select 'INVALID_ROLE'::text, null::uuid, null::uuid;
        return;
    end if;

    if not exists (
        select 1
        from public.tenant_memberships as tm
        join public.tenants as t on t.tenant_id = tm.tenant_id
        where tm.tenant_id = p_tenant_id
          and tm.user_id = p_invited_by
          and tm.membership_role = 'owner'
          and tm.membership_status = 'active'
          and t.tenant_status = 'active'
    ) then
        return query select 'NOT_OWNER'::text, null::uuid, null::uuid;
        return;
    end if;

    select u.id into v_existing_user_id
    from auth.users as u
    where lower(u.email) = v_email
    limit 1;

    -- One company per user: anyone already holding a membership (in this tenant or another) cannot
    -- be invited.
    if v_existing_user_id is not null and exists (
        select 1 from public.tenant_memberships as tm where tm.user_id = v_existing_user_id
    ) then
        return query select 'ALREADY_MEMBER'::text, null::uuid, v_existing_user_id;
        return;
    end if;

    -- A lapsed invitation must not block a fresh one.
    update public.invitation_member as im
    set status = 'expired'
    where im.email = v_email
      and im.status = 'pending'
      and im.expires_at <= now();

    begin
        insert into public.invitation_member (tenant_id, email, user_id, membership_role, invited_by)
        values (p_tenant_id, v_email, v_existing_user_id, p_membership_role, p_invited_by)
        returning invitation_member.invitation_id into v_invitation_id;
    exception
        when unique_violation then
            return query select 'ALREADY_INVITED'::text, null::uuid, v_existing_user_id;
            return;
    end;

    return query select 'CREATED'::text, v_invitation_id, v_existing_user_id;
end;
$$;

revoke all on function public.create_member_invitation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_member_invitation(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- accept_member_invitation — the invitee's own setup step (authenticated).
--
-- Accepts only the invitee's personal details. The tenant and the role come exclusively from the
-- pending invitation row matched to auth.uid() (or, before the user id was written back, to the
-- session's own verified email). Never inserts a tenant or a subscription.
-- ---------------------------------------------------------------------------
create or replace function public.accept_member_invitation(
    p_full_name text,
    p_phone_number text,
    p_professional_role text
)
returns table (
    tenant_id uuid,
    membership_role text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
    v_email text;
    v_full_name text;
    v_phone_number text;
    v_professional_role text;
    v_invitation public.invitation_member%rowtype;
    v_existing_tenant_id uuid;
    v_existing_role text;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Authentication is required to accept an invitation' using errcode = '28000';
    end if;

    v_email := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));

    v_full_name := btrim(coalesce(p_full_name, ''));
    v_phone_number := btrim(coalesce(p_phone_number, ''));
    v_professional_role := btrim(coalesce(p_professional_role, ''));

    if length(v_full_name) = 0 or length(v_full_name) > 200 then
        raise exception 'Full name must be between 1 and 200 characters' using errcode = '22023';
    end if;
    if length(v_phone_number) = 0 or length(v_phone_number) > 32 then
        raise exception 'Phone number must be between 1 and 32 characters' using errcode = '22023';
    end if;
    if length(v_professional_role) = 0 or length(v_professional_role) > 120 then
        raise exception 'Professional role must be between 1 and 120 characters' using errcode = '22023';
    end if;

    -- Idempotency for a retry / double-click after a successful accept.
    select tm.tenant_id, tm.membership_role
    into v_existing_tenant_id, v_existing_role
    from public.tenant_memberships as tm
    where tm.user_id = v_user_id;

    if v_existing_tenant_id is not null then
        return query select v_existing_tenant_id, v_existing_role;
        return;
    end if;

    select im.* into v_invitation
    from public.invitation_member as im
    where im.status = 'pending'
      and im.expires_at > now()
      and (
          im.user_id = v_user_id
          or (im.user_id is null and v_email <> '' and im.email = v_email)
      )
    order by im.created_at desc
    limit 1
    for update;

    if v_invitation.invitation_id is null then
        raise exception 'No pending invitation was found for this account' using errcode = 'P0002';
    end if;

    insert into public.profiles (user_id, full_name, phone_number, professional_role)
    values (v_user_id, v_full_name, v_phone_number, v_professional_role)
    on conflict (user_id) do update
        set full_name = excluded.full_name,
            phone_number = excluded.phone_number,
            professional_role = excluded.professional_role;

    insert into public.tenant_memberships (tenant_id, user_id, membership_role, membership_status)
    values (v_invitation.tenant_id, v_user_id, v_invitation.membership_role, 'active');

    update public.invitation_member as im
    set status = 'accepted',
        accepted_at = now(),
        user_id = v_user_id
    where im.invitation_id = v_invitation.invitation_id;

    return query select v_invitation.tenant_id, v_invitation.membership_role;
end;
$$;

revoke all on function public.accept_member_invitation(text, text, text) from public, anon;
grant execute on function public.accept_member_invitation(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- list_tenant_members — service role only. Members of one tenant with their sign-in email, which
-- lives in auth.users and is not reachable through PostgREST.
-- ---------------------------------------------------------------------------
create or replace function public.list_tenant_members(p_tenant_id uuid)
returns table (
    user_id uuid,
    full_name text,
    email text,
    membership_role text,
    membership_status text,
    joined_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
    select tm.user_id,
           coalesce(p.full_name, ''),
           coalesce(u.email, ''),
           tm.membership_role,
           tm.membership_status,
           tm.created_at
    from public.tenant_memberships as tm
    left join public.profiles as p on p.user_id = tm.user_id
    left join auth.users as u on u.id = tm.user_id
    where tm.tenant_id = p_tenant_id
    order by tm.created_at desc;
$$;

revoke all on function public.list_tenant_members(uuid) from public, anon, authenticated;
grant execute on function public.list_tenant_members(uuid) to service_role;
