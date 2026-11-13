// Every page of Veylo, for the browser checks of slice W6 (crawler, page states, responsive, axe).
// The 28 pages the brief names come first, grouped as Public (7), Owner app (17) and Contractor
// portal (4); the extra pages (account screens, the 404) follow. Paths use the demo world's ids.

export const ORG = "11111111-1111-4111-8111-111111111111";
export const OPEN_RUN = "22222222-2222-4222-8222-222222222222";
export const DONE_RUN = "22222222-2222-4222-8222-333333333333";
export const KWAME = "33333333-3333-4333-8333-333333333333";
export const ITEM_DIRECT = "66666666-6666-4666-8666-666666666663";
export const ITEM_PRIVATE = "66666666-6666-4666-8666-666666666664";
export const TOKEN = "A".repeat(43);

/**
 * name, path, group; `signedIn: false` loads it as a visitor (sign-in, the invite page).
 * `states` says which designed states the page has, and the check proves each one:
 *   loading  a skeleton shows while the API is slow
 *   error    plain words and a way to try again show when the API fails
 *   empty    a designed empty state shows when there is nothing yet (a regexp for its heading)
 */
export const REQUIRED_PAGES = [
  // ---- Public (7) ----
  { name: "landing", path: "/", group: "public", signedIn: false },
  {
    name: "verify-payout",
    path: `/verify?payout=${ITEM_DIRECT}`,
    group: "public",
    signedIn: false,
  },
  { name: "privacy-proof", path: "/proof", group: "public", signedIn: false },
  { name: "docs", path: "/docs", group: "public", signedIn: false },
  { name: "security", path: "/security", group: "public", signedIn: false },
  { name: "privacy-policy", path: "/privacy", group: "public", signedIn: false },
  { name: "terms", path: "/terms", group: "public", signedIn: false },
  // ---- Owner app (17) ----
  { name: "sign-in", path: "/app/sign-in", group: "owner", signedIn: false },
  { name: "organisation-setup", path: "/app/setup", group: "owner" },
  { name: "treasury-home", path: "/app", group: "owner", states: { loading: true, error: true } },
  {
    name: "fund-treasury",
    path: "/app/fund",
    group: "owner",
    states: { loading: true, error: true },
  },
  {
    name: "contractors",
    path: "/app/contractors",
    group: "owner",
    states: { loading: true, error: true, empty: /No contractors yet/ },
  },
  {
    name: "contractor-detail",
    path: `/app/contractor?id=${KWAME}`,
    group: "owner",
    states: { loading: true, error: true, empty: /No payout address/ },
  },
  { name: "csv-import", path: "/app/contractors/import", group: "owner" },
  {
    name: "payee-registry",
    path: "/app/payees",
    group: "owner",
    states: { loading: true, error: true, empty: /No signed payee list yet/ },
  },
  {
    name: "pay-runs",
    path: "/app/pay-runs",
    group: "owner",
    states: { loading: true, error: true, empty: /No pay runs yet/ },
  },
  {
    name: "pay-run-review",
    path: `/app/pay-run?id=${OPEN_RUN}`,
    group: "owner",
    states: { loading: true, error: true },
  },
  {
    name: "pay-run-status",
    path: `/app/pay-run/status?id=${DONE_RUN}`,
    group: "owner",
    states: { loading: true, error: true },
  },
  {
    name: "payroll-schedules",
    path: "/app/schedules",
    group: "owner",
    states: { loading: true, error: true, empty: /No schedule yet/ },
  },
  {
    name: "ledger",
    path: "/app/ledger",
    group: "owner",
    states: { loading: true, error: true, empty: /Nothing in the ledger yet/ },
  },
  {
    name: "statements",
    path: "/app/statements",
    group: "owner",
    states: { loading: true, error: true, empty: /No statements yet/ },
  },
  {
    name: "audit-log",
    path: "/app/audit",
    group: "owner",
    states: { loading: true, error: true, empty: /Nothing matches|No activity/ },
  },
  {
    name: "team-and-roles",
    path: "/app/team",
    group: "owner",
    states: { loading: true, error: true },
  },
  {
    name: "settings",
    path: "/app/settings",
    group: "owner",
    states: { loading: true, error: true },
  },
  // ---- Contractor portal (4) ----
  {
    name: "portal-invite",
    path: `/portal/accept?token=${TOKEN}`,
    group: "portal",
    signedIn: false,
  },
  {
    name: "portal-address",
    path: "/portal/address",
    group: "portal",
    states: { loading: true, error: true, empty: /no payout address yet/i },
  },
  {
    name: "portal-payments",
    path: "/portal",
    group: "portal",
    states: { loading: true, error: true, empty: /No payments yet/ },
  },
  {
    name: "portal-balance",
    path: "/portal/balance",
    group: "portal",
    states: { loading: true, error: true },
  },
];

export const EXTRA_PAGES = [
  { name: "sign-up", path: "/app/sign-up", group: "account", signedIn: false },
  {
    name: "verify-email",
    path: `/app/verify-email?token=${TOKEN}`,
    group: "account",
    signedIn: false,
  },
  { name: "forgot-password", path: "/app/forgot-password", group: "account", signedIn: false },
  {
    name: "reset-password",
    path: `/app/reset-password?token=${TOKEN}`,
    group: "account",
    signedIn: false,
  },
  { name: "portal-invite-signed-in", path: `/portal/accept?token=${TOKEN}`, group: "portal" },
  { name: "add-address", path: `/app/contractor/add-address?id=${KWAME}`, group: "owner" },
  { name: "app-privacy-proof", path: "/app/privacy-proof", group: "owner" },
  {
    name: "verify-private",
    path: `/verify?payout=${ITEM_PRIVATE}`,
    group: "public",
    signedIn: false,
  },
  {
    name: "not-found",
    path: "/this-page-does-not-exist",
    group: "public",
    signedIn: false,
    status: 404,
  },
];

export const ALL_PAGES = [...REQUIRED_PAGES, ...EXTRA_PAGES];

/** The widths the brief names, plus phone landscape. */
export const WIDTHS = [320, 360, 375, 390, 414, 768, 834, 1024, 1280, 1440, 1920];
export const HEIGHT_FOR = (w) => (w < 500 ? 800 : w < 1000 ? 1000 : 900);
export const LANDSCAPE = { width: 844, height: 390 };

/** Device emulation (Chromium with each device's size, scale, touch and user agent). */
export const DEVICES = [
  { name: "iPhone SE", descriptor: "iPhone SE" },
  { name: "iPhone 15", descriptor: "iPhone 15" },
  { name: "Pixel 7", descriptor: "Pixel 7" },
  { name: "iPad", descriptor: "iPad (gen 7)" },
  { name: "Desktop 1920", viewport: { width: 1920, height: 1080 } },
];
