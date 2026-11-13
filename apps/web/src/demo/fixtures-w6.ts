// Made-up data for the slice W6 pages in the demo world: exchange rates, settings, team, audit log,
// payroll schedule. Nothing here is real. The demo never saves, signs or sends anything.

export const DEMO_FX = {
  available: true as const,
  base: "USD" as const,
  // Made-up numbers with the same shape as a real answer. Rates are decimal text, never floats.
  rates: {
    NGN: "1550.250000",
    EUR: "0.920000",
    GBP: "0.790000",
    KES: "129.100000",
    INR: "83.200000",
    GHS: "15.400000",
    ZAR: "18.500000",
    BRL: "5.100000",
  },
  source: {
    name: "Demo rates (made up)",
    url: "https://example.com/",
    termsUrl: "https://example.com/",
    attribution: "Demo rates, made up for this page",
  },
  fetchedAt: "2026-11-05T17:30:50.957Z",
  providerUpdatedAt: null,
};

export const DEMO_SETTINGS = {
  displayCurrency: "EUR",
  timeZone: "Africa/Lagos",
  notifications: { payrollReady: true, payoutSettled: true, weeklySummary: false },
};

export const DEMO_SCHEDULE = {
  schedule: {
    kind: "monthly" as const,
    dayOfMonth: 25,
    anchorDate: null,
    timeZone: "Africa/Lagos",
    paused: false,
  },
  next: { payday: "2026-11-25", prepareOn: "2026-11-22" },
};

export const DEMO_MEMBERS = (ownerAccount: string) => [
  {
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    nearAccountId: ownerAccount,
    email: "kelvin@northwind.example",
    role: "owner" as const,
  },
  {
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
    nearAccountId: null,
    email: "preparer@northwind.example",
    role: "preparer" as const,
  },
  {
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000003",
    nearAccountId: null,
    email: "accountant@northwind.example",
    role: "accountant" as const,
  },
];

export const DEMO_AUDIT = [
  {
    id: "cccccccc-cccc-4ccc-8ccc-000000000001",
    at: "2026-11-05T17:34:00.000Z",
    actor: "kelvin@northwind.example",
    action: "pay_run.sign",
    entity: "pay_run",
    entityId: "22222222-2222-4222-8222-222222222222",
    txHash: null,
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-000000000002",
    at: "2026-11-05T17:20:00.000Z",
    actor: "kelvin@northwind.example",
    action: "payee.approve",
    entity: "payee",
    entityId: "55555555-5555-4555-8555-555555555555",
    txHash: null,
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-000000000003",
    at: "2026-11-05T10:05:00.000Z",
    actor: "preparer@northwind.example",
    action: "contractor.create",
    entity: "contractor",
    entityId: "33333333-3333-4333-8333-333333333333",
    txHash: null,
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-000000000004",
    at: "2026-11-05T09:50:00.000Z",
    actor: "kelvin@northwind.example",
    action: "org.settings_update",
    entity: "organization",
    entityId: "11111111-1111-4111-8111-111111111111",
    txHash: null,
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-000000000005",
    at: "2026-11-05T09:30:00.000Z",
    actor: "kelvin@northwind.example",
    action: "auth.email_sign_in",
    entity: "user",
    entityId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    txHash: null,
  },
];

/** The import check, as the API does it for a header line and rows; nothing is saved in the demo. */
export function demoImportCheck(csv: string) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const rows = lines.slice(1).map((line, i) => {
    const [name = "", email = "", route = "", account = ""] = line.split(",").map((c) => c.trim());
    const problems: string[] = [];
    if (!name) problems.push("Add the person's name.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      problems.push("The email doesn't look right.");
    if (route !== "private" && route !== "direct")
      problems.push("Route must be private or direct.");
    if (!account) problems.push("Add the NEAR account.");
    return { line: i + 2, name, ok: problems.length === 0, problems };
  });
  return { rows, saved: false as const, created: 0 };
}
