// Depositing USDC straight into NEAR Intents from your own NEAR account (W7.3), with no one-time
// deposit address and no 1Click fee. This is what the Verifier contract documents:
//   https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits
// call `ft_transfer_call` on the token contract with `receiver_id` = intents.near, an integer
// `amount`, and `msg` = the account that will own the balance (empty means the sender), attaching
// exactly 1 yoctoNEAR; "100 TGas is sufficient for a simple deposit".
//
// Veylo does not make this call for you: it changes what a wallet signs, so for now the screen shows
// the exact call to make from a wallet or the NEAR CLI that can send a contract call. Nothing here
// touches the network; it only builds text for a person to copy, and the tests pin every field.
import { FUNDING_ORIGINS } from "@veylo/core";

/** The NEAR Intents (Verifier) contract. */
export const INTENTS_CONTRACT = "intents.near";
/** The method the deposit docs name, and what to attach to it. */
export const DEPOSIT_METHOD = "ft_transfer_call";
export const DEPOSIT_GAS_TGAS = 100;
export const DEPOSIT_ATTACHED = "1 yoctoNEAR";
/**
 * NEAR the sending account must hold to attach 100 TGas. Gas is bought up front at no less than
 * 0.001 NEAR per TGas, so 100 TGas takes 0.1 NEAR from the balance when the call is sent; what isn't
 * burned comes back one block later (the docs' own example: 50 TGas burned costs 0.005 NEAR).
 * https://docs.near.org/protocol/transactions/gas, "Buying vs. burning gas".
 */
export const DEPOSIT_MIN_NEAR = "0.1";
/** The one-time storage the USDC contract asks to register a new account (storage_balance_bounds). */
export const USDC_STORAGE_NEAR = "0.00125";

const usdc = FUNDING_ORIGINS.find((o) => o.id === "usdc-near");
if (!usdc) throw new Error("the funding origins have no USDC on NEAR");
/** The USDC contract: the part of the asset id after `nep141:`. */
export const USDC_CONTRACT = usdc.assetId.replace(/^nep141:/, "");

export type DirectDeposit = {
  readonly contract: string;
  readonly method: string;
  /** The arguments as JSON text, ready to paste. */
  readonly args: string;
  readonly attached: string;
  readonly gas: string;
  /** The same call for the NEAR CLI (near-cli-rs), as the NEAR docs write it. */
  readonly cli: string;
};

/**
 * The exact call. `units` is the amount in USDC's smallest unit (6 decimals, so 1 USDC is 1000000),
 * as a whole number; `treasuryAccountId` is the account that will own the balance.
 */
export function directDeposit(input: { units: bigint; treasuryAccountId: string }): DirectDeposit {
  if (input.units <= 0n) throw new RangeError("a deposit needs a positive amount");
  if (!/^[a-z0-9._-]{2,64}$/.test(input.treasuryAccountId))
    throw new RangeError("the treasury account isn't a NEAR account id");
  const args = JSON.stringify({
    receiver_id: INTENTS_CONTRACT,
    amount: input.units.toString(),
    msg: input.treasuryAccountId,
  });
  return {
    contract: USDC_CONTRACT,
    method: DEPOSIT_METHOD,
    args,
    attached: DEPOSIT_ATTACHED,
    gas: `${DEPOSIT_GAS_TGAS} TGas`,
    cli:
      `near contract call-function as-transaction ${USDC_CONTRACT} ${DEPOSIT_METHOD} ` +
      `json-args '${args}' prepaid-gas '${DEPOSIT_GAS_TGAS} Tgas' attached-deposit '${DEPOSIT_ATTACHED}' ` +
      `sign-as <your-account> network-config mainnet sign-with-keychain send`,
  };
}
