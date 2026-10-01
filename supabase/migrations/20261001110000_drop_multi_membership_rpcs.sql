-- One-to-one membership, step 2: drop the RPCs only multi-membership used. Apply this only after
-- the one-to-one app code is live, so the running app never calls a function that is gone.
--   join_invited_workspace    — one-click "join another company" for someone with an account
--   decline_member_invitation — declining one of several company invitations
--   create_owned_workspace    — "+ Create new company" for someone who already has a company
begin;

drop function if exists public.join_invited_workspace(uuid);
drop function if exists public.decline_member_invitation(uuid);
drop function if exists public.create_owned_workspace(text, text);

commit;
