import { EventEmitter } from "node:events";
import { createHarness } from "./test-support.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installShutdown } from "./lifecycle.js";

const quiet = { info: () => {}, error: () => {} };

describe("installShutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s runs every step in order, once, then exits 0",
    async (sig) => {
      const order: string[] = [];
      const exit = vi.fn();
      const target = new EventEmitter();
      installShutdown({
        steps: [
          { name: "http", run: async () => void order.push("http") },
          { name: "database", run: async () => void order.push("database") },
        ],
        log: quiet,
        exit,
        target: target as never,
      });
      target.emit(sig);
      target.emit("SIGTERM");
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
      expect(order).toEqual(["http", "database"]);
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    },
  );

  it("an IPC shutdown message does the same", async () => {
    const exit = vi.fn();
    const target = new EventEmitter();
    installShutdown({ steps: [], log: quiet, exit, target: target as never });
    target.emit("message", "something else");
    expect(exit).not.toHaveBeenCalled();
    target.emit("message", "shutdown");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("a failing step still runs the rest, and exits 1", async () => {
    const ran: string[] = [];
    const exit = vi.fn();
    const target = new EventEmitter();
    installShutdown({
      steps: [
        { name: "a", run: () => Promise.reject(new Error("boom")) },
        { name: "b", run: () => void ran.push("b") },
      ],
      log: quiet,
      exit,
      target: target as never,
    });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(ran).toEqual(["b"]);
  });

  it("a stuck step hits the deadline and exits 1", async () => {
    const exit = vi.fn();
    const target = new EventEmitter();
    installShutdown({
      steps: [{ name: "stuck", run: () => new Promise(() => {}) }],
      log: quiet,
      exit,
      target: target as never,
      timeoutMs: 20,
    });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});

describe("the API stops accepting requests and closes, in-process", () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.client.close();
  });

  it("serves, then on SIGTERM refuses new connections and closes the database last", async () => {
    const app = await h.build();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const order: string[] = [];
    const exit = vi.fn();
    const target = new EventEmitter();
    installShutdown({
      steps: [
        {
          name: "http",
          run: async () => {
            await app.close();
            order.push("http");
          },
        },
        { name: "database", run: async () => void order.push("database") },
      ],
      log: quiet,
      exit,
      target: target as never,
    });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(["http", "database"]);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
