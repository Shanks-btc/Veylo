// The settlement worker's shutdown steps, separate from worker.ts so tests can prove the order.
import type { ShutdownStep } from "./lifecycle.js";

type Boss = {
  stop(options?: { graceful?: boolean; close?: boolean; timeout?: number }): Promise<void>;
};
type Pool = { end(): Promise<void> };

export function createWorkerShutdownSteps(w: {
  ticker: ReturnType<typeof setInterval>;
  boss: Boss;
  pool: Pool;
  stopTimeoutMs?: number;
}): ShutdownStep[] {
  return [
    // No new sends from this process.
    { name: "ticker", run: () => clearInterval(w.ticker) },
    // pg-boss stops fetching, waits for in-flight jobs up to the timeout, and closes its own
    // connections. A job still running at the timeout isn't lost: its row stays active, pg-boss
    // retries it after expiry, and every job is an idempotent sweep.
    {
      name: "pg-boss",
      run: () => w.boss.stop({ graceful: true, close: true, timeout: w.stopTimeoutMs ?? 20_000 }),
    },
    { name: "database", run: () => w.pool.end() },
  ];
}
