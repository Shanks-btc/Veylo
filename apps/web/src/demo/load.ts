// Loads the demo world, in demo builds only (NEXT_PUBLIC_DEMO=1). In a production build the
// condition below is constant false and the dynamic import is dropped, so the demo world and its
// recorded data never reach the output (a test greps for the marker).
import type { DemoWorld } from "./world";

let world: Promise<DemoWorld> | undefined;

export function loadDemoWorld(): Promise<DemoWorld> {
  if (process.env.NEXT_PUBLIC_DEMO === "1") {
    return (world ??= import("./world").then((m) => m.createDemoWorld()));
  }
  return Promise.reject(new Error("not a demo build"));
}

export const isDemo = (): boolean => process.env.NEXT_PUBLIC_DEMO === "1";
