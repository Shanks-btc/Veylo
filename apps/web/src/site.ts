// The public site origin, for canonical links, Open Graph and the sitemap. Inlined at build.
export function siteOrigin(): string {
  const value = process.env.NEXT_PUBLIC_SITE_ORIGIN;
  if (!value) throw new Error("NEXT_PUBLIC_SITE_ORIGIN is required at build");
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SITE_ORIGIN must be an https origin, with no path");
  }
  return url.origin;
}

export const SITE_TITLE = "Veylo · Private payroll on NEAR";
export const SITE_DESCRIPTION =
  "Private payroll on NEAR: salaries are paid through NEAR Confidential Intents, so they aren't publicly linked to your company. Gasless for everyone.";
/** The evidence condition, verbatim, wherever privacy is claimed (also in the Open Graph text). */
export const PRIVACY_CONDITION =
  "Private means no public source we checked links a confidential payout to the company, provided the payout address has never received a public payment from it.";
