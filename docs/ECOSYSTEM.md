# Ecosystem fit: NEAR Business, Trezu and multisig treasuries

Slice W6 asked whether Veylo can sit on top of the NEAR ecosystem's multisig treasuries: could a NEAR Business treasury be the Veylo treasury, and could a multisig (Trezu, or a SputnikDAO-style contract) authorise Veylo's payouts? This is a documents-only study. Nothing was built, because no documented, supported path was found (verdicts below).

Read on 2026-11-12. Sources are named with each claim. Where a claim rests on Veylo's own code or on a page whose exact address was not recorded, it says so.

## What Veylo needs from a treasury

Every Veylo payout is a NEAR Intents **signed intent** (NEP-413): the treasury account's key signs a message, and NEAR Intents settles it. Veylo's server never holds a key. Before the owner's wallet signs, the browser checks the quote's signature, the owner-signed payee list, that the signing key is really the treasury's (gate B2, `has_public_key` on the `intents.near` verifier), and the exact amount. These are Veylo's rules in [ARCHITECTURE.md](../ARCHITECTURE.md); the key check is in `packages/chains` and `apps/web/src/gates`.

So a treasury is usable by Veylo only if it can produce an ed25519 NEP-413 signature that the Intents verifier accepts for the treasury account.

## NEAR Business

What the docs say (<https://docs.business.near.com/>, read 2026-11-12): a cross-chain multisig solution for managing confidential digital assets. A multisig smart contract on NEAR holds the treasury; members have roles (Governance, Requestor, Finance); payment requests are proposed by members and approved by others. Bulk payments accept a CSV of address and amount for one token. The pages we read do not mention payroll, pay runs or payslips, and describe no public API.

**Verdict: not feasible as Veylo's treasury today.** The treasury is a contract account. A contract account has no private key, so it cannot produce the NEP-413 signature Veylo's flow is built on. We found no documented way for a third-party app to start a payment from a NEAR Business treasury, and no signed-intent flow for third parties. Not built.

## Trezu and SputnikDAO-style multisig

What we found: Trezu's documentation is at <https://github.com/NEAR-DevHub/trezu-docs> (read 2026-11-12). It describes a multisig built on the SputnikDAO family of contracts: a proposal is created, others vote, and the contract executes the action when the threshold is met.

**Can a multisig authorise an Intents payout?** The Intents verifier accepts an intent signed by a key registered for an account (Veylo's gate B2 checks exactly this with `has_public_key`). A contract account can register a key through a function call, `add_public_key`, if its multisig approves that call. The registered key then signs intents for that account **alone**. So the multisig's approvals would apply once, to registering the key, and not to each payment. Whoever holds that key could spend the account's Intents balance without any further approval.

**Verdict: not built, and not recommended.** The only path we can see turns a k-of-n approval into a single hot key. That would also hand Veylo (or whoever holds the key) the signing power the whole design avoids: "Veylo's server can't move money". We did not find a documented verifier feature that limits a registered key (per payment approval, spending limits, or threshold signing). If one is documented later, this verdict should be revisited. The exact page of the Intents docs that describes `add_public_key` was not recorded in this study; the behaviour above is what Veylo's own gate B2 code relies on.

## A multi-approver pay run that keeps Veylo's rules

Several approvers for a pay run is on the roadmap. The design that fits Veylo's rules, without a multisig contract:

1. **One signer stays.** The treasury is still one account with one key, held in the owner's wallet. Only that wallet signs payouts. Veylo's server still holds no key.
2. **Approvers sign a statement, not the payment.** Each approver (an owner or a role we add) connects their own wallet and signs a NEP-413 message: "Approve pay run `<run id>`, total `<amount>`, payee list version `<n>`, hash `<hash of every line>`". The message is built by the browser from the pay run it just verified, never taken from the server.
3. **A new browser gate checks the approvals.** Before the treasury wallet is asked to sign any payout, the browser verifies k distinct approvers' signatures over the same run hash, that each approver's key belongs to their account (same key check as gate B2), and that each is an active approver on the owner-signed list. Fewer than k, a changed amount, a changed payee or an expired approval locks signing, exactly like the other gates.
4. **Gates A, B, B2 and C stay as they are.** The new gate is additional.
5. **The honest limit.** The count is enforced by the signer's browser, not on chain. A treasury owner who wants to ignore it can, because they hold the only key. This is an approval workflow and an audit trail, not custody split among people. True on-chain k-of-n for Intents payouts would need the verifier to support it (see the verdict above).

**Verdict: feasible as a workflow; it needs a founder decision on the roles before it is built.** Not built in W6.

## Summary

| Partner or path                                                  | Feasible today?   | Why                                                                                                                   | Built?       |
| ---------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- | ------------ |
| NEAR Business treasury as Veylo's treasury                       | No                | Contract account: no key, so no NEP-413 signature; no documented third-party path or API                              | No           |
| Trezu or a SputnikDAO-style multisig authorising Intents payouts | Not safely        | The only route registers one key that then signs alone, which defeats the multisig and the "server holds no key" rule | No           |
| Several approvers for a pay run, as an approval workflow         | Yes, with a limit | Approvers sign a run hash; a browser gate checks them; the treasury key stays single                                  | No (roadmap) |

No integration is mandatory for the hackathon (Q-011, per the founder's brief); these paths were studied because the ecosystem has them, not because they are required.
