/** Base class for every error this package throws. `code` is stable and safe to match on. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class MoneyError extends DomainError {
  constructor(message: string) {
    super("MONEY_INVALID", message);
  }
}

export class InconsistentQuoteError extends DomainError {
  constructor(message: string) {
    super("QUOTE_INCONSISTENT", message);
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(
    readonly machine: "payout_attempt" | "pay_run",
    readonly from: string,
    readonly to: string,
  ) {
    super("TRANSITION_INVALID", `${machine} cannot move from ${from} to ${to}`);
  }
}

export class AttemptInvariantError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

export class ModeMismatchError extends DomainError {
  constructor(message: string) {
    super("MODE_MISMATCH", message);
  }
}
