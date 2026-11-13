// Writes src/design/tokens.css from src/design/tokens.ts, the one source of design tokens.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokensCss } from "../src/design/tokens.ts";

const out = fileURLToPath(new URL("../src/design/tokens.css", import.meta.url));
writeFileSync(out, tokensCss());
console.log("tokens: wrote src/design/tokens.css");
