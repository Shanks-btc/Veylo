// The emails Veylo sends (slice W6): plain text, no tracking, one link each. Pure functions, so the
// API writes them to its outbox and the demo app can render the same text in the browser.
// A password reset never restores a wallet: both mails that touch an account say so plainly.

export type EmailMessage = { subject: string; body: string };

export const WALLET_NOT_RESTORED =
  "Resetting your password does not give you back a wallet. Only your recovery phrase or a passkey you registered can restore a Veylo wallet. Veylo cannot recover it for you.";

export function verifyEmailMessage(input: { link: string }): EmailMessage {
  return {
    subject: "Confirm your email for Veylo",
    body: [
      "Hello,",
      "",
      "Confirm this email address to finish setting up your Veylo account:",
      input.link,
      "",
      "The link works once and expires in 24 hours. If you did not sign up, ignore this email.",
      "",
      "Your email is only for signing in and notices. It cannot sign or approve payments.",
    ].join("\n"),
  };
}

export function resetPasswordMessage(input: { link: string }): EmailMessage {
  return {
    subject: "Reset your Veylo password",
    body: [
      "Hello,",
      "",
      "Someone asked to reset the password for this Veylo account. To choose a new one:",
      input.link,
      "",
      "The link works once and expires in one hour. If you did not ask, ignore this email and your password stays as it is.",
      "",
      WALLET_NOT_RESTORED,
    ].join("\n"),
  };
}

export function contractorInviteMessage(input: {
  organisation: string;
  link: string;
}): EmailMessage {
  return {
    subject: `${input.organisation} invited you to see your payslips on Veylo`,
    body: [
      "Hello,",
      "",
      `${input.organisation} uses Veylo for payroll and invited you to see your payslips and set your payout address:`,
      input.link,
      "",
      "The link works once and expires after a few days. If you were not expecting it, ignore this email.",
    ].join("\n"),
  };
}
