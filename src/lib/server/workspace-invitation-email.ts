import "server-only";

/**
 * Invitation email for someone who ALREADY has an AgentzPro login (multi-membership).
 *
 * Supabase's inviteUserByEmail only emails brand-new addresses, so for an existing account the
 * app sends this notice itself through Resend's HTTP API. The person signs in and accepts the
 * invitation on /workspaces — the email carries no token, so a forwarded email grants nothing.
 *
 * Needs RESEND_API_KEY and INVITE_EMAIL_FROM (e.g. "AgentzPro <invites@agentzpro.com>", a sender
 * on a domain verified in Resend). Returns false when not configured or when sending fails.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function sendExistingAccountInvitationEmail(input: {
  email: string;
  companyName: string;
  loginUrl: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.INVITE_EMAIL_FROM;
  if (!apiKey || !from) {
    return false;
  }

  const company = escapeHtml(input.companyName);
  const loginUrl = escapeHtml(input.loginUrl);

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [input.email],
        subject: `${input.companyName} invited you to join them on AgentzPro`,
        html:
          `<p><strong>${company}</strong> invited you to join their company on AgentzPro.</p>` +
          `<p>Sign in with this email address and accept the invitation:</p>` +
          `<p><a href="${loginUrl}">Sign in to AgentzPro</a></p>` +
          `<p>If you were not expecting this, you can ignore this email.</p>`,
        text:
          `${input.companyName} invited you to join their company on AgentzPro.\n\n` +
          `Sign in with this email address and accept the invitation: ${input.loginUrl}\n\n` +
          `If you were not expecting this, you can ignore this email.`,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
