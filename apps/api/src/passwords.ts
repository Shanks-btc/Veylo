// Email-account passwords (slice W6). Argon2id with the OWASP minimum cost (19 MiB, 2 passes, 1 lane),
// stored as a PHC string with its own parameters so the cost can rise later without a migration.
// This password is for the email login only. It never encrypts or unlocks a wallet key: the wallet
// is protected inside the wallet bridge origin, by a passkey or a separate wallet password, and the
// two secrets are never the same thing (a test checks that neither reaches the other side).
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { base64nopad } from "@scure/base";

export const ARGON2_PARAMS = { t: 2, m: 19_456, p: 1, dkLen: 32 } as const;
const SALT_BYTES = 16;

const enc = new TextEncoder();

export async function hashPassword(
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<string> {
  const salt = random(SALT_BYTES);
  const hash = await argon2idAsync(enc.encode(password), salt, ARGON2_PARAMS);
  const { m, t, p } = ARGON2_PARAMS;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${base64nopad.encode(salt)}$${base64nopad.encode(hash)}`;
}

function parsePhc(phc: string) {
  const parts = phc.split("$");
  // ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") return undefined;
  const params = Object.fromEntries(
    (parts[3] ?? "").split(",").map((kv) => kv.split("=") as [string, string]),
  );
  let salt: Uint8Array;
  let hash: Uint8Array;
  try {
    salt = base64nopad.decode(parts[4] ?? "");
    hash = base64nopad.decode(parts[5] ?? "");
  } catch {
    return undefined;
  }
  // The cost parameters are small whole numbers: read digit by digit, like every number here.
  const num = (k: string) => {
    const text = params[k] ?? "";
    return /^\d{1,8}$/.test(text)
      ? [...text].reduce((n, ch) => n * 10 + (ch.charCodeAt(0) - 48), 0)
      : undefined;
  };
  const m = num("m");
  const t = num("t");
  const p = num("p");
  if (!m || !t || !p) return undefined;
  return { m, t, p, salt, hash };
}

/** Constant-time over the hash bytes; false for anything malformed. */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  // A stored cost far above ours is not something this process should run for a login.
  if (parsed.m > 262_144 || parsed.t > 10 || parsed.p > 4) return false;
  const got = await argon2idAsync(enc.encode(password), parsed.salt, {
    t: parsed.t,
    m: parsed.m,
    p: parsed.p,
    dkLen: parsed.hash.length,
  });
  let diff = got.length ^ parsed.hash.length;
  for (let i = 0; i < got.length; i += 1) diff |= (got[i] ?? 0) ^ (parsed.hash[i] ?? 0);
  return diff === 0;
}

/** A fixed hash to verify against when the email is unknown, so timing doesn't reveal accounts. */
export const DUMMY_PHC =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const COMMON = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "passw0rd123",
  "1234567890",
  "12345678910",
  "qwertyuiop",
  "qwerty12345",
  "letmein1234",
  "iloveyou123",
  "welcome1234",
  "admin12345",
  "changeme123",
  "abcdefghij",
  "0123456789",
  "1q2w3e4r5t",
  "football123",
  "monkey12345",
  "trustno1234",
]);

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Returns a plain-words reason the password is refused, or undefined if it is fine. */
export function passwordProblem(password: string, email: string): string | undefined {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower))
    return "That password is too common. Pick something only you would think of.";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (lower === email.trim().toLowerCase() || (local.length >= 4 && lower.includes(local)))
    return "Do not use your email address in your password.";
  if (new Set(password).size < 5) return "Use a mix of different characters.";
  return undefined;
}
