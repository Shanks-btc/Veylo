import { ModeMismatchError } from "./errors.js";

export const MODES = ["live", "simulated"] as const;

/** Live and simulated records are separate. Simulated records never count as real (ARCHITECTURE §1.5). */
export type Mode = (typeof MODES)[number];

/** Implemented by every money-bearing domain object. */
export type HasMode = { readonly mode: Mode };

/** Returns the shared mode, or throws if live and simulated objects are mixed. */
export function assertSameMode(objects: readonly HasMode[]): Mode {
  const [first, ...rest] = objects;
  if (!first) throw new ModeMismatchError("no objects to compare");
  for (const other of rest) {
    if (other.mode !== first.mode) {
      throw new ModeMismatchError(`cannot mix ${first.mode} and ${other.mode} objects`);
    }
  }
  return first.mode;
}
