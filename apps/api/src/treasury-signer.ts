import { isOwnerKey } from "@veylo/chains";
import { getActiveMembershipByAccount, getOrganization } from "@veylo/db";
import type { FastifyBaseLogger } from "fastify";
import type { Deps } from "./app.js";
import { notFound } from "./errors.js";

/** L28: the treasury account itself, an active owner, with a key that is really its own (NEAR RPC). */
export async function assertTreasurySigner(
  deps: Pick<Deps, "db" | "rpc">,
  log: FastifyBaseLogger,
  orgId: string,
  signer: { accountId: string; publicKey: string },
  reject: () => Error,
) {
  const org = await getOrganization(deps.db, orgId);
  if (!org) throw notFound();
  if (signer.accountId !== org.treasuryAccountId) throw reject();
  const member = await getActiveMembershipByAccount(deps.db, orgId, signer.accountId);
  if (member?.role !== "owner") throw reject();
  let owns = false;
  try {
    owns = await isOwnerKey(deps.rpc, signer.accountId, signer.publicKey);
  } catch (err) {
    log.warn({ err }, "signer key check failed");
  }
  if (!owns) throw reject();
  return org.treasuryAccountId;
}
