# Funding the treasury

Slice W7.3, 2026-11-14. How USDC gets into a Veylo treasury, what was checked against the official docs and on the chain, and the exact steps to fund a treasury today. Decision L68.

## What "funded" means

A Veylo treasury is an account on NEAR Intents: the USDC balance that **your treasury account** (the wallet account you signed in with) holds inside the Verifier contract `intents.near`. Payouts are paid from that balance. USDC that merely sits in your wallet account, on the USDC contract, is **not** in the treasury yet. So funding is always one of two things:

1. **A one-time deposit address (the default on the Fund screen).** You send USDC to an address Veylo shows you, with a plain token transfer from an exchange or any NEAR wallet. NEAR Intents' 1Click service credits your treasury.
2. **A direct deposit from your own NEAR account.** You call NEAR Intents' documented deposit method yourself.

Nothing in Veylo moves or signs for you in either case: Veylo only shows an address (after your browser has checked 1Click's signature on it) or the exact call.

## What was checked (read-only, nothing was sent)

Everything below was checked on 2026-11-14 with documentation reads, public RPC view calls and 1Click quote requests. No transaction was sent and no funds moved.

| Question                                                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                            | Source                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How does a token get from a NEAR account into the NEAR Intents balance?           | `ft_transfer_call` on the token contract with `receiver_id` = `intents.near`, an integer `amount`, and `msg` = the account that will own the balance (empty means the sender). Attach exactly 1 yoctoNEAR. "100 TGas is sufficient for a simple deposit."                                                                                                                                                         | [NEAR Intents: Deposits](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits)                                     |
| Which USDC?                                                                       | The native (Circle) USDC contract `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`; its `ft_metadata` says name `USDC`, symbol `USDC`. The bridged USDC.e is a different token and is not what Veylo uses.                                                                                                                                                                                      | RPC `ft_metadata`; [Circle: USDC on NEAR](https://www.circle.com/multi-chain-usdc/near)                                                                     |
| Can a brand-new 64-hex (implicit) account that holds 0 NEAR receive USDC?         | It doesn't have to exist on-chain to hold a balance in the token contract, **but the token contract must have registered it** (NEP-145 storage). For USDC that costs **0.00125 NEAR** (`storage_balance_bounds` min = max = `1250000000000000000000` yocto), and a fresh account reads `storage_balance_of` = `null` (unregistered). The docs say to register the receiver before `ft_transfer`; the sender pays. | [NEAR docs: Fungible tokens](https://docs.near.org/integrations/fungible-tokens), [NEP-145](https://github.com/near/NEPs/blob/master/neps/nep-0145.md), RPC |
| Does a brand-new account exist, and can it sign, with 0 NEAR?                     | No. An implicit account is only derived locally; "the first transfer to the address creates the account", and the sender pays a 0.007 NEAR creation charge. Until then it can't send a transaction.                                                                                                                                                                                                               | [NEAR docs: Accounts](https://docs.near.org/integrations/accounts), [Gas](https://docs.near.org/protocol/transactions/gas)                                  |
| What NEAR does the direct deposit need?                                           | Gas is bought up front at no less than 0.001 NEAR per TGas, so attaching 100 TGas takes **0.1 NEAR** from the balance when the call is sent. What isn't burned is refunded one block later (the docs' example: 50 TGas burned costs 0.005 NEAR).                                                                                                                                                                  | [NEAR docs: Gas, "Buying vs. burning gas"](https://docs.near.org/protocol/transactions/gas)                                                                 |
| Does 1Click quote USDC on NEAR to a treasury (same asset) **without** an API key? | Yes. A dry quote and a real quote both answered 201: 1.0 USDC in, 1.0 USDC out, minimum out 0.995, about 20 seconds, refund fee 0.003952 USDC. The quote is signed. Without a key the docs add 0.25% to the quote's fee (with a key: 0.01% for stablecoin and same-asset routes).                                                                                                                                 | [Fees](https://docs.near-intents.org/resources/fees), [quote reference](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)          |
| Does the deposit status work without a key?                                       | Yes, for a deposit quoted without a key: `PENDING_DEPOSIT` came back. (A deposit quoted **with** the key returned 404 without it, T5b.)                                                                                                                                                                                                                                                                           | [Making a request](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request)                                  |
| Is a 1Click deposit address already registered with the USDC contract?            | **No.** Two real quotes gave two new 64-hex addresses; both had `storage_balance_of` = `null` on the USDC contract and don't exist as accounts on-chain. So the sender's transfer to it must come with the 0.00125 NEAR registration. Exchanges and most wallet apps are said to attach it (BitGo's NEAR docs describe it for exchanges), but that is **not verified for any particular exchange or wallet**.     | RPC `storage_balance_of`; [BitGo: NEAR](https://developers.bitgo.com/docs/near)                                                                             |
| Does 1Click settle a same-asset USDC-on-NEAR deposit?                             | **Not verified.** The quote is accepted, but no real deposit has been made (spike S-F1, VERIFICATION.md). The first real deposit is that test: start with 1 USDC.                                                                                                                                                                                                                                                 |                                                                                                                                                             |

## Why Veylo does not sign the direct deposit for you (yet)

The direct deposit is a transaction your wallet would sign. Veylo's wallet layer signs messages (NEP-413) only; letting it sign a contract call is a change to what a wallet signs, which this project treats as a founder decision. Until then the Fund screen shows the exact call, with copy buttons, for a wallet or the NEAR CLI that can send a contract call. The one-time deposit address needs no signing at all, which is why it is the default.

## Fund a treasury with 1 to 2 USDC today

**Route 1: the one-time deposit address (recommended).**

1. Sign in at https://veylopay.vercel.app, open **Fund treasury**, keep **Send USDC on NEAR** selected.
2. Type the amount (1 or 2) and press **Get my deposit address**. Your browser checks 1Click's signature and that the funds go to your own treasury, then shows a 64-character address, a QR code, the exact amount and a "valid until" time.
3. Send exactly that amount of **USDC on the NEAR network** to that address:
   - **From an exchange:** withdraw USDC, choose the network **NEAR** (not Ethereum, not "USDC.e"), paste the address. You need no NEAR; the exchange pays.
   - **From a NEAR wallet:** send USDC to the address. Keep some NEAR in that wallet for the network fee: a token transfer attaches 30 TGas, which takes 0.03 NEAR up front (mostly refunded, [gas docs](https://docs.near.org/protocol/transactions/gas)). If the wallet doesn't register the new address with the USDC contract itself, the transfer fails and nothing is lost: add 0.00125 NEAR and use Route 2 instead.
4. Press **I've sent it: check the status**. The words go from "Waiting for your deposit" to "Done. The funds are in your treasury", and the Public balance at the top of the page goes up by about the amount.
5. Set the refund address (the field on the form) to an account that has held USDC before, such as the account you send from: a refund is a token transfer, and the account receiving it must be registered with the USDC contract.

Your treasury account itself needs **no NEAR** for Route 1.

**Route 2: straight into NEAR Intents from your own NEAR account (no one-time address, no 1Click fee).**

Open **Deposit straight into NEAR Intents from your own NEAR account** on the Fund screen. It shows the call to make:

- Contract: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
- Method: `ft_transfer_call`
- Arguments: `{"receiver_id":"intents.near","amount":"<USDC × 1,000,000>","msg":"<your treasury account>"}` (1 USDC is `1000000`)
- Attach: 1 yoctoNEAR, 100 TGas
- The account sending it must hold the USDC and **at least 0.1 NEAR**. A brand-new account needs someone to send it NEAR first (about 0.15 NEAR covers the 0.007 NEAR creation charge and the 0.1 NEAR).

## What is still open

- A real, small same-asset deposit (spike S-F1) has not been made. Route 1 is the way to run it: the founder sends 1 USDC.
- Whether a given exchange or wallet registers the one-time address with the USDC contract is not known. If it doesn't, use Route 2.
- Signing the deposit inside Veylo (so Route 2 is one click) needs transaction signing in the wallet bridge: a founder decision, not made here.
