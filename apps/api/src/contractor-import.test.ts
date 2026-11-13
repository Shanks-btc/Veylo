// Contractor CSV import (slice W5, C5): good and bad rows, in the parser and through the API.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseContractorImport, parseCsv } from "./contractor-import.js";
import { addMember, createHarness, createOrg, signIn, type App } from "./test-support.js";

const HEADER = "name,email,route,near_account";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\r\n");

describe("parseCsv", () => {
  it("reads quotes, escaped quotes, commas and CRLF or LF", () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\nf,g,h\n')).toEqual([
      ["a", "b, c", 'd "e"'],
      ["f", "g", "h"],
    ]);
  });
  it("ignores a byte-order mark and blank lines", () => {
    expect(parseCsv("﻿a,b\n\n,\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
  it("refuses a quote that is never closed", () => {
    expect(() => parseCsv('a,"b')).toThrow(/never closed/);
  });
});

describe("parseContractorImport", () => {
  it("accepts the sample file in docs/", () => {
    const text = readFileSync(
      new URL("../../../docs/contractors-sample.csv", import.meta.url),
      "utf8",
    );
    const r = parseContractorImport(text);
    expect(r.fileProblem).toBeUndefined();
    if (r.fileProblem === undefined) {
      expect(r.reports.every((x) => x.ok)).toBe(true);
      expect(r.rows.map((x) => x.account)).toEqual(["ada-l.near", "grace-h.near"]);
    }
  });

  it("accepts good rows, with the account lowercased and a blank email as none", () => {
    const r = parseContractorImport(
      csv("Ada Lovelace,Ada@Example.com,Private,Ada-L.near", "Bo,,private,bo.near"),
    );
    expect(r).toMatchObject({
      rows: [
        { name: "Ada Lovelace", email: "Ada@Example.com", route: "private", account: "ada-l.near" },
        { email: null },
      ],
    });
  });

  it.each<[string, string, RegExp]>([
    ["an empty name", ",a@b.co,private,ada.near", /name is empty/],
    ["a name with a line break", '"A\nB",,private,ada.near', /line break/],
    ["a bad email", "Ada,not-an-email,private,ada.near", /email isn't a valid/],
    ["an unknown route", "Ada,,wire,ada.near", /route must be/],
    ["the direct route, until S-N passes", "Ada,,direct,ada.near", /coming soon/],
    ["an empty account", "Ada,,private,", /near_account is empty/],
    ["an invalid account", "Ada,,private,Not An Account!", /near_account/],
    ["a short row", "Ada,,private", /columns/],
  ])("reports %s", (_what, row, problem) => {
    const r = parseContractorImport(csv(row));
    expect(r.fileProblem).toBeUndefined();
    if (r.fileProblem === undefined) {
      expect(r.reports[0]?.ok).toBe(false);
      expect(r.reports[0]?.problems.join(" | ")).toMatch(problem);
      expect(r.rows).toHaveLength(0);
    }
  });

  it("flags a duplicate account or email inside the file, naming the first line", () => {
    const r = parseContractorImport(
      csv("A,a@x.co,private,ada.near", "B,b@x.co,private,ADA.near", "C,a@x.co,private,c.near"),
    );
    if (r.fileProblem !== undefined) throw new Error(r.fileProblem);
    expect(r.reports.map((x) => x.ok)).toEqual([true, false, false]);
    expect(r.reports[1]?.problems).toEqual(["near_account is a duplicate of line 2"]);
    expect(r.reports[2]?.problems).toEqual(["email is a duplicate of line 2"]);
  });

  it.each([
    ["", /empty/],
    [HEADER, /no contractors/],
    ["name,email,route\nA,,private", /first line must be exactly/],
    ["name,email,route,account\nA,,private,x.near", /first line must be exactly/],
  ])("refuses a file with a bad shape: %j", (text, problem) => {
    expect(parseContractorImport(text as string).fileProblem).toMatch(problem as RegExp);
  });

  it("refuses too many rows and too large a file", () => {
    const many = csv(...Array.from({ length: 201 }, (_, i) => `N${i},,private,acct${i}.near`));
    expect(parseContractorImport(many).fileProblem).toMatch(/At most 200/);
    expect(parseContractorImport("x".repeat(100_001)).fileProblem).toMatch(/too large/);
  });
});

describe("import through the API", () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let app: App;
  let cookies: Record<string, string>;
  let orgId: string;
  beforeAll(async () => {
    h = await createHarness();
    app = await h.build();
    const owner = await signIn(app);
    cookies = owner.cookies;
    orgId = (await createOrg(app, cookies)).id;
    // These accounts exist on NEAR; "ghost.near" doesn't.
    for (const a of ["ada-l.near", "grace-h.near", "taken.near"]) h.chain.set(a, new Map());
  });
  afterAll(async () => {
    await app.close();
    await h.client.close();
  });
  const send = (text: string, save: boolean, as = cookies) =>
    app.inject({
      method: "POST",
      url: `/orgs/${orgId}/contractors/import`,
      cookies: as,
      payload: { csv: text, save },
    });
  const list = async () =>
    (
      (await app.inject({ method: "GET", url: `/orgs/${orgId}/contractors`, cookies })).json() as {
        contractors: { name: string }[];
      }
    ).contractors;

  it("shows every row with its problems, and saves nothing while any row is bad", async () => {
    const text = csv(
      "Ada Lovelace,,private,ada-l.near",
      "Ghost,,private,ghost.near",
      "Bad,,wire,x.near",
    );
    const res = await send(text, true);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: { line: number; ok: boolean; problems: string[] }[];
      saved: boolean;
      created: number;
    };
    expect(body.saved).toBe(false);
    expect(body.created).toBe(0);
    expect(body.rows.map((r) => r.ok)).toEqual([true, false, false]);
    expect(body.rows[1]?.problems).toEqual(["this account doesn't exist on NEAR"]);
    expect(body.rows[2]?.problems.join()).toMatch(/route must be/);
    expect(await list()).toHaveLength(0);
  });

  it("a preview (save: false) creates nothing even when every row is good", async () => {
    const res = await send(csv("Ada Lovelace,,private,ada-l.near"), false);
    expect(res.json()).toMatchObject({ saved: false, created: 0, rows: [{ ok: true }] });
    expect(await list()).toHaveLength(0);
  });

  it("saves a good file: contractors with their address, payable only once the treasury approves", async () => {
    const res = await send(
      readFileSync(new URL("../../../docs/contractors-sample.csv", import.meta.url), "utf8"),
      true,
    );
    expect(res.json()).toMatchObject({ saved: true, created: 2 });
    const contractors = (await list()) as { name: string; id?: string }[];
    expect(contractors.map((c) => c.name).sort()).toEqual(["Ada Lovelace", "Grace Hopper"]);
    const full = (
      await app.inject({ method: "GET", url: `/orgs/${orgId}/contractors`, cookies })
    ).json() as { contractors: { id: string }[] };
    const dest = (
      await app.inject({
        method: "GET",
        url: `/orgs/${orgId}/contractors/${full.contractors[0]?.id}/destinations`,
        cookies,
      })
    ).json() as { destinations: { payable: boolean; payableReason: string }[] };
    expect(dest.destinations[0]).toMatchObject({
      payable: false,
      payableReason: "owner_approval_required",
    });
  });

  it("refuses an account that is already a contractor's payout address", async () => {
    const res = await send(csv("Again,,private,ada-l.near"), true);
    expect((res.json() as { rows: { problems: string[] }[] }).rows[0]?.problems).toEqual([
      "this NEAR account is already a contractor's payout address",
    ]);
  });

  it("an account NEAR doesn't know is refused, never passed", async () => {
    const res = await send(csv("Ghost,,private,never-funded.near"), false);
    expect((res.json() as { rows: { ok: boolean }[] }).rows[0]?.ok).toBe(false);
  });

  it("a preparer can import; an accountant can't", async () => {
    const prep = await addMember(app, cookies, orgId, "preparer");
    expect((await send(csv("Taken,,private,taken.near"), false, prep.cookies)).statusCode).toBe(
      200,
    );
    const acct = await addMember(app, cookies, orgId, "accountant");
    expect((await send(csv("Taken,,private,taken.near"), false, acct.cookies)).statusCode).toBe(
      403,
    );
  });

  it("rejects a file with the wrong header as a 400 with the reason", async () => {
    const res = await send("name,email\nA,b", false);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "IMPORT_FILE_INVALID" } });
  });
});
