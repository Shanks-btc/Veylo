// Self-test for _util.ts. Uses fake values only.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { record, redact, registerSecret } from "../_util.js";

const R = "[REDACTED]";
const FAKE_KEY = "ed25519:FAKEsecretKEY123";
process.env.TREASURY_SECRET_KEY = FAKE_KEY;
process.env.ONECLICK_JWT = "fake.jwt.value";
process.env.NEARAI_API_KEY = "";
delete process.env.X402_FACILITATOR_API_KEY;

const cases: [string, () => void][] = [
  ["secret inside a URL string is redacted", () => {
    const out = redact({ url: "https://x.test/a?param=fake.jwt.value&b=1" });
    assert.deepEqual(out, { url: `https://x.test/a?param=${R}&b=1` });
  }],
  ["URL-encoded secret is redacted", () => {
    const out = redact({ url: `https://x.test/?k=${encodeURIComponent(FAKE_KEY)}` });
    assert.deepEqual(out, { url: `https://x.test/?k=${R}` });
  }],
  ["secret nested inside a string under an unlisted key is redacted", () => {
    const out = redact({ a: [{ note: `failed with ${FAKE_KEY} here` }] });
    assert.deepEqual(out, { a: [{ note: `failed with ${R} here` }] });
  }],
  ["contractor secret keys are redacted by value", () => {
    process.env.CONTRACTOR_SOLANA_SECRET_KEY = "fakeSolanaSecret";
    process.env.CONTRACTOR_EVM_SECRET_KEY = "0xfakeEvmSecret";
    process.env.CONTRACTOR_TRON_SECRET_KEY = "FAKETRONSECRET";
    const out = redact({ a: "fakeSolanaSecret", b: "x 0xfakeEvmSecret y", c: "https://x.test/FAKETRONSECRET" });
    assert.deepEqual(out, { a: R, b: `x ${R} y`, c: `https://x.test/${R}` });
  }],
  ["registerSecret values are redacted", () => {
    registerSecret("runtime-access-token");
    registerSecret("");
    const out = redact({ msg: "Bearer runtime-access-token" });
    assert.deepEqual(out, { msg: `Bearer ${R}` });
  }],
  ["public_key, prompt_tokens and attestation signature stay visible", () => {
    const input = {
      public_key: "ed25519:pub",
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      model_attestations: [{ signature: "0xabc", signing_address: "0xdef" }],
    };
    assert.deepEqual(redact(input), input);
  }],
  ["authorization header is redacted, any case", () => {
    const out = redact({ headers: { Authorization: "Bearer zzz", authorization: "Bearer yyy" } });
    assert.deepEqual(out, { headers: { Authorization: R, authorization: R } });
  }],
  ["every listed key name is redacted", () => {
    for (const k of ["X-API-Key", "secret_key", "private_key", "api_key", "JWT", "accessToken", "refreshToken"]) {
      assert.deepEqual(redact({ [k]: "v" }), { [k]: R }, k);
    }
  }],
  ["no substring matching on key names", () => {
    const input = { tokens: 1, monkey: 2, api_key_id: 3, my_secret_key: 4, tokenIn: 5 };
    assert.deepEqual(redact(input), input);
  }],
  ["empty and unset env values match nothing", () => {
    assert.deepEqual(redact({ s: "plain text" }), { s: "plain text" });
  }],
  ["input is not mutated", () => {
    const input = { Authorization: "Bearer zzz" };
    redact(input);
    assert.equal(input.Authorization, "Bearer zzz");
  }],
  ["record() writes redacted output", () => {
    const path = record("TEST", "util", { url: `https://x.test/?k=${FAKE_KEY}`, public_key: "pub" });
    const text = readFileSync(path, "utf8");
    rmSync(path);
    assert.ok(!text.includes(FAKE_KEY));
    assert.ok(text.includes("pub"));
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${name}\n${err instanceof Error ? err.message : err}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
