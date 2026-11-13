// Writes docs/WALLETS.md from the committed wallet lock and review (slice W6). Local, no network.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderWalletsDoc } from "./wallets-doc-lib.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(web, "src", "wallet", f), "utf8"));
const out = join(web, "..", "..", "docs", "WALLETS.md");
writeFileSync(out, renderWalletsDoc(read("wallets.lock.json"), read("wallets.review.json")));
console.log("wrote docs/WALLETS.md");
