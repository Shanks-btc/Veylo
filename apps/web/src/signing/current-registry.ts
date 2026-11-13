// The payee registry as this browser verifies it (gate B's verifyRegistry), for payee signing.
// The treasury account is the connected wallet's, never the API's. No head yet is accepted only
// when this browser has never seen one for the org (the high-water mark is 0): a served "no head"
// can't roll back a registry this browser already verified.
import type { ApiClient } from "../api/client";
import { verifyRegistry } from "../gates/registry";
import type { HighWaterStore } from "../gates/high-water";
import type { GateRpc } from "../gates/rpc";
import { PayeeRequestError, type CurrentRegistry } from "./payee-requests";

export async function loadCurrentRegistry(input: {
  api: ApiClient;
  orgId: string;
  treasuryAccountId: string;
  authRecipient: string;
  rpc: GateRpc;
  highWater: HighWaterStore;
  now: Date;
}): Promise<CurrentRegistry> {
  const registry = await input.api.call("GET /orgs/:orgId/payee-registry", {
    params: { orgId: input.orgId },
  });
  if (!registry.head) {
    if ((await input.highWater.get(input.orgId)) !== 0)
      throw new PayeeRequestError("the payee list disappeared since this browser last checked it");
    if (registry.approvals.length > 0)
      throw new PayeeRequestError("approvals without a signed payee list");
    return { version: 0, payees: [] };
  }
  const verified = await verifyRegistry({ ...input, registry });
  if (!verified.ok) throw new PayeeRequestError(verified.reason);
  return { version: verified.version, payees: verified.payees };
}
