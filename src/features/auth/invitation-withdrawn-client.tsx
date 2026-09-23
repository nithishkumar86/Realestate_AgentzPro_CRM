export interface InvitationWithdrawnClientProps {
  tenantName: string;
}

/**
 * Shown when someone opens an invite email after the owner withdrew that invitation. It is only a
 * message: there is nothing to act on, and they never see the new-company form.
 */
export function InvitationWithdrawnClient({ tenantName }: Readonly<InvitationWithdrawnClientProps>) {
  return (
    <div className="auth-card" role="alert">
      <h1 className="auth-card__title">Invitation withdrawn</h1>
      <p className="auth-card__subtitle">
        The invitation to join <strong>{tenantName}</strong> was withdrawn by the organization owner, so this link can no
        longer be used. If you think this is a mistake, contact the owner and ask them to send a new invitation.
      </p>
    </div>
  );
}
