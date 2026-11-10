// Graceful shutdown for the API and the workers. On SIGTERM or SIGINT (or, on Windows where a
// parent can't send signals, an IPC "shutdown" message), each step runs once, in order, and the
// process exits 0 if every step succeeded. A deadline stops a stuck shutdown.
type Log = { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
type Target = {
  once(event: "SIGTERM" | "SIGINT", fn: () => void): unknown;
  on?(event: "message", fn: (m: unknown) => void): unknown;
};

export type ShutdownStep = { name: string; run: () => Promise<void> | void };

export function installShutdown(options: {
  steps: readonly ShutdownStep[];
  log: Log;
  exit: (code: number) => void;
  target: Target;
  timeoutMs?: number;
}) {
  let started = false;
  async function shutdown(reason: string) {
    if (started) return;
    started = true;
    options.log.info({ reason }, "shutting down");
    const timer = setTimeout(() => {
      options.log.error({}, "shutdown timed out");
      options.exit(1);
    }, options.timeoutMs ?? 30_000);
    let code = 0;
    for (const step of options.steps) {
      try {
        await step.run();
      } catch (err) {
        options.log.error({ err, step: step.name }, "shutdown step failed");
        code = 1;
      }
    }
    clearTimeout(timer);
    options.log.info({ code }, "shut down");
    options.exit(code);
  }
  options.target.once("SIGTERM", () => void shutdown("SIGTERM"));
  options.target.once("SIGINT", () => void shutdown("SIGINT"));
  options.target.on?.("message", (m) => {
    if (m === "shutdown") void shutdown("ipc");
  });
  return shutdown;
}
