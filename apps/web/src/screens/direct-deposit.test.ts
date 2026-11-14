// The direct deposit call (W7.3) is built to the letter of NEAR Intents' deposit documentation. Every
// field is pinned here, so a change to what a person is told to sign is a visible, reviewed change.
// Source: https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits
import { describe, expect, it } from "vitest";
import {
  DEPOSIT_ATTACHED,
  DEPOSIT_GAS_TGAS,
  DEPOSIT_METHOD,
  DEPOSIT_MIN_NEAR,
  INTENTS_CONTRACT,
  USDC_CONTRACT,
  USDC_STORAGE_NEAR,
  directDeposit,
} from "./direct-deposit";

const TREASURY = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";

describe("the direct deposit call", () => {
  it("is ft_transfer_call on the native USDC contract, to intents.near, owned by the treasury", () => {
    const call = directDeposit({ units: 1_500_000n, treasuryAccountId: TREASURY });
    expect(call.contract).toBe("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    expect(call.method).toBe("ft_transfer_call");
    expect(JSON.parse(call.args)).toEqual({
      receiver_id: "intents.near",
      amount: "1500000",
      msg: TREASURY,
    });
    expect(call.attached).toBe("1 yoctoNEAR");
    expect(call.gas).toBe("100 TGas");
  });

  it("states the amount as a whole number in USDC's smallest unit, never a decimal", () => {
    expect(JSON.parse(directDeposit({ units: 1n, treasuryAccountId: TREASURY }).args).amount).toBe(
      "1",
    );
    expect(
      JSON.parse(directDeposit({ units: 250_500_000n, treasuryAccountId: TREASURY }).args).amount,
    ).toBe("250500000");
    expect(
      JSON.stringify(directDeposit({ units: 1_000_000n, treasuryAccountId: TREASURY })),
    ).not.toMatch(/\d\.\d/);
  });

  it("gives the same call for the NEAR CLI, as the NEAR docs write it", () => {
    const call = directDeposit({ units: 1_000_000n, treasuryAccountId: TREASURY });
    expect(call.cli).toBe(
      `near contract call-function as-transaction ${USDC_CONTRACT} ft_transfer_call json-args '${call.args}' ` +
        `prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as <your-account> network-config mainnet sign-with-keychain send`,
    );
  });

  it("refuses a zero or negative amount and an account that isn't a NEAR account id", () => {
    expect(() => directDeposit({ units: 0n, treasuryAccountId: TREASURY })).toThrow(RangeError);
    expect(() => directDeposit({ units: -5n, treasuryAccountId: TREASURY })).toThrow(RangeError);
    expect(() => directDeposit({ units: 1n, treasuryAccountId: "" })).toThrow(RangeError);
    expect(() => directDeposit({ units: 1n, treasuryAccountId: "bad account!" })).toThrow(
      RangeError,
    );
    expect(() => directDeposit({ units: 1n, treasuryAccountId: 'x","y":"z' })).toThrow(RangeError);
  });

  it("the constants are the documented ones", () => {
    expect(INTENTS_CONTRACT).toBe("intents.near");
    expect(DEPOSIT_METHOD).toBe("ft_transfer_call");
    expect(DEPOSIT_GAS_TGAS).toBe(100);
    expect(DEPOSIT_ATTACHED).toBe("1 yoctoNEAR");
    // Gas is bought up front at no less than 0.001 NEAR per TGas: 100 TGas is 0.1 NEAR.
    expect(DEPOSIT_MIN_NEAR).toBe("0.1");
    // The USDC contract's own storage_balance_bounds: 1250000000000000000000 yoctoNEAR.
    expect(USDC_STORAGE_NEAR).toBe("0.00125");
  });
});
