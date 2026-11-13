// Builds the wallet bridge (L44, W6) into out-bridge/:
//   w/<wallet id>/index.html  one page per enabled external wallet, each with its own CSP that names
//                             only that wallet's reviewed hosts (src/wallet/wallets.lock.json);
//   embedded/index.html       the Veylo wallet page: own script and style only, no network at all;
//   index.html                a plain "only works inside the Veylo app" page;
//   main.js, embedded.js      the bundled page scripts;
//   wallets/                  the SHA-256-pinned executors of the enabled wallets;
//   wallet-icons/             their icons, so near-connect shows them from this origin;
//   vercel.json               the headers for every page.
// The Veylo API is not reachable from any of these pages.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bridgePolicy, embeddedPolicy } from "./bridge-csp.mjs";
import { assertOrigins } from "./csp-lib.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const out = join(web, "out-bridge");
const appOrigin = process.env.BRIDGE_APP_ORIGIN;
const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;
const nearRpcUrl = process.env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://rpc.fastnear.com";
if (!appOrigin || new URL(appOrigin).origin !== appOrigin) {
  console.error("bridge: BRIDGE_APP_ORIGIN must be the app's origin, e.g. https://app.example.com");
  process.exit(1);
}

assertOrigins([appOrigin, nearRpcUrl, ...(apiOrigin ? [apiOrigin] : [])]);
const lock = JSON.parse(readFileSync(join(web, "src", "wallet", "wallets.lock.json"), "utf8"));
const enabled = lock.wallets.filter((w) => w.enabled);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const define = {
  __APP_ORIGIN__: JSON.stringify(appOrigin),
  __NEAR_RPC_URL__: JSON.stringify(nearRpcUrl),
};
const common = {
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  define,
  logLevel: "warning",
};
await build({
  ...common,
  entryPoints: [join(web, "bridge", "main.ts")],
  outfile: join(out, "main.js"),
});
const embeddedEntry = join(web, "bridge", "embedded", "main.ts");
if (existsSync(embeddedEntry)) {
  await build({ ...common, entryPoints: [embeddedEntry], outfile: join(out, "embedded.js") });
  cpSync(join(web, "bridge", "embedded", "embedded.css"), join(out, "embedded.css"));
  // The shared design tokens (written by gen-tokens.mjs), so the wallet page matches the app.
  cpSync(join(web, "src", "design", "tokens.css"), join(out, "tokens.css"));
}
cpSync(join(web, "public", "wallets"), join(out, "wallets"), { recursive: true });
cpSync(join(web, "public", "wallet-icons"), join(out, "wallet-icons"), { recursive: true });

const page = (policy, body, htmlAttrs = "") => `<!doctype html>
<html lang="en"${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${policy.meta.replaceAll('"', "&quot;")}">
<meta name="robots" content="noindex">
<title>Veylo wallet</title>
${body.head ?? ""}</head>
<body>
${body.body}
</body>
</html>
`;

const baseline = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Permissions-Policy",
    // The Veylo wallet page may use passkeys (publickey-credentials-*) when framed by the app; no
    // other page may.
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];
const rules = [];

for (const w of enabled) {
  const policy = bridgePolicy({ appOrigin, nearRpcUrl, apiOrigin, wallet: w });
  mkdirSync(join(out, "w", w.id), { recursive: true });
  writeFileSync(
    join(out, "w", w.id, "index.html"),
    page(
      policy,
      { body: '<script type="module" src="/main.js"></script>' },
      ` data-wallet="${w.id}"`,
    ),
  );
  rules.push({
    source: `/w/${w.id}/(.*)`,
    headers: [{ key: "Content-Security-Policy", value: policy.header }, ...baseline],
  });
}

if (existsSync(embeddedEntry)) {
  const policy = embeddedPolicy({ appOrigin });
  mkdirSync(join(out, "embedded"), { recursive: true });
  writeFileSync(
    join(out, "embedded", "index.html"),
    page(policy, {
      head: '<link rel="stylesheet" href="/tokens.css">\n<link rel="stylesheet" href="/embedded.css">\n',
      body: '<main id="root" class="shell"></main>\n<script type="module" src="/embedded.js"></script>',
    }),
  );
  rules.push({
    source: "/embedded/(.*)",
    headers: [
      { key: "Content-Security-Policy", value: policy.header },
      ...baseline.filter((h) => h.key !== "Permissions-Policy"),
      {
        key: "Permissions-Policy",
        value:
          "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
      },
    ],
  });
}

// Everything else on this origin (the root page, scripts, executors, icons).
writeFileSync(
  join(out, "index.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Veylo wallet</title></head>
<body><p>This page only works inside the Veylo app.</p></body></html>
`,
);
// The root files each get the baseline on their own rule. There is deliberately no catch-all "/(.*)":
// it would also match /w/<id>/ and /embedded/, and whichever host orders duplicate headers could then
// let its Permissions-Policy replace the Veylo wallet page's passkey permission (a browser check found
// exactly that). No two rules here match the same path.
for (const source of [
  "/",
  "/main.js",
  "/embedded.js",
  "/embedded.css",
  "/tokens.css",
  "/wallets/(.*)",
  "/wallet-icons/(.*)",
]) {
  rules.push({ source, headers: baseline });
}

writeFileSync(join(out, "vercel.json"), JSON.stringify({ headers: rules }, null, 2) + "\n");
console.log(
  `bridge: built for ${appOrigin}: ${enabled.length} wallet page(s)${existsSync(embeddedEntry) ? " and the Veylo wallet page" : ""}`,
);
