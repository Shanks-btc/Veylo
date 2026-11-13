// Contractor CSV import (slice W5, C5): parsing and the checks that need no network. Columns:
// name, email, route (private or direct), near_account. The live checks (does the account exist on
// NEAR, is it already someone's) are in contractor-routes.ts.
import { isSafeMessageText, ROUTE_AVAILABILITY } from "@veylo/core";
import { validateAddress } from "@veylo/chains";

export const IMPORT_COLUMNS = ["name", "email", "route", "near_account"] as const;
export const MAX_IMPORT_ROWS = 200;
export const MAX_IMPORT_BYTES = 100_000;

/** RFC 4180: quoted cells, "" for a quote, CRLF or LF. A UTF-8 byte-order mark is ignored. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw new RangeError("a quoted cell is never closed");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type ImportRow = {
  /** The line in the file (the header is line 1). */
  line: number;
  name: string;
  email: string | null;
  route: "private" | "direct";
  account: string;
};
export type RowReport = { line: number; name: string; ok: boolean; problems: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedImport =
  { fileProblem: string } | { fileProblem?: undefined; rows: ImportRow[]; reports: RowReport[] };

/** Everything that can be checked without the network, including duplicates inside the file. */
export function parseContractorImport(text: string): ParsedImport {
  if (text.length > MAX_IMPORT_BYTES) return { fileProblem: "The file is too large." };
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (err) {
    return { fileProblem: `The file isn't a valid CSV: ${(err as Error).message}.` };
  }
  const [header, ...body] = table;
  if (!header) return { fileProblem: "The file is empty." };
  const names = header.map((h) => h.trim().toLowerCase());
  if (names.join(",") !== IMPORT_COLUMNS.join(","))
    return { fileProblem: `The first line must be exactly: ${IMPORT_COLUMNS.join(",")}` };
  if (body.length === 0) return { fileProblem: "The file has a header and no contractors." };
  if (body.length > MAX_IMPORT_ROWS)
    return { fileProblem: `At most ${MAX_IMPORT_ROWS} contractors per file.` };

  const rows: ImportRow[] = [];
  const reports: RowReport[] = [];
  const seenAccount = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  body.forEach((cells, i) => {
    const line = i + 2;
    const problems: string[] = [];
    if (cells.length !== IMPORT_COLUMNS.length)
      problems.push(`has ${cells.length} columns, expected ${IMPORT_COLUMNS.length}`);
    const [rawName = "", rawEmail = "", rawRoute = "", rawAccount = ""] = cells.map((c) =>
      c.trim(),
    );

    if (rawName === "") problems.push("name is empty");
    else if (rawName.length > 200) problems.push("name is longer than 200 characters");
    else if (!isSafeMessageText(rawName))
      problems.push("name has a line break or hidden character");

    if (rawEmail !== "" && (!EMAIL.test(rawEmail) || rawEmail.length > 320))
      problems.push("email isn't a valid address");

    const routeWord = rawRoute.toLowerCase();
    if (routeWord !== "private" && routeWord !== "direct")
      problems.push('route must be "private" or "direct"');
    else if (routeWord === "direct" && ROUTE_AVAILABILITY["usdc-near"] !== "enabled")
      problems.push("direct payouts aren't available yet (coming soon)");

    const account = rawAccount.toLowerCase();
    const syntax = validateAddress("near", account);
    if (rawAccount === "") problems.push("near_account is empty");
    else if (!syntax.ok) problems.push(`near_account: ${syntax.message}`);
    else {
      const first = seenAccount.get(account);
      if (first !== undefined) problems.push(`near_account is a duplicate of line ${first}`);
      else seenAccount.set(account, line);
    }
    if (rawEmail !== "" && EMAIL.test(rawEmail)) {
      const e = rawEmail.toLowerCase();
      const first = seenEmail.get(e);
      if (first !== undefined) problems.push(`email is a duplicate of line ${first}`);
      else seenEmail.set(e, line);
    }

    reports.push({ line, name: rawName, ok: problems.length === 0, problems });
    if (problems.length === 0)
      rows.push({
        line,
        name: rawName,
        email: rawEmail === "" ? null : rawEmail,
        route: routeWord as "private" | "direct",
        account,
      });
  });
  return { rows, reports };
}
