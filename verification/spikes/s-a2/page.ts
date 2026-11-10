// Throwaway. Connects Meteor, signs two recorded payloads, and shows the raw output. Sends nothing anywhere.
import { NearConnector } from "@hot-labs/near-connect";
import payloads from "./payloads.json";
import manifest from "./manifest.meteor.json";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
type Result = { label: string; verifierRequested: string; ok: boolean; at: string; pending?: boolean; returnedAt?: string; rawOutput?: unknown; outputTypes?: Record<string, string>; error?: string };

// Kept in this browser only, so a reload or reconnect cannot erase a signature or hide a pending request.
const STORE = "s-a2-results";
const loadStored = (): Result[] => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]") as Result[];
  } catch {
    return [];
  }
};
const results: Result[] = loadStored().map((r) => (r.pending ? { ...r, pending: false, error: r.error ?? "PAGE RELOADED while waiting: the wallet call never returned to this page" } : r));
const pageLoads = Number(sessionStorage.getItem("s-a2-loads") ?? "0") + 1;
sessionStorage.setItem("s-a2-loads", String(pageLoads));
const state: { connectedAccounts?: unknown; userAgent: string; connector: string; pageUrl: string; pageLoadsThisTab: number; pageErrors: string[] } = {
  userAgent: navigator.userAgent,
  connector: "@hot-labs/near-connect@0.12.0",
  pageUrl: location.origin,
  pageLoadsThisTab: pageLoads,
  pageErrors: [],
};
const seenRequests = new Set<string>();
window.addEventListener("error", (e) => {
  state.pageErrors.push(`error: ${e.message}`);
  render();
});
window.addEventListener("unhandledrejection", (e) => {
  state.pageErrors.push(`unhandled rejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`);
  render();
});

// Show bytes as bytes, so an unexpected shape is recorded rather than flattened by JSON.
function describe(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __type: "Uint8Array", base64: btoa(String.fromCharCode(...value)) };
  if (Array.isArray(value)) return value.map(describe);
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value)?.constructor?.name;
    const entries = Object.entries(value).map(([k, v]) => [k, describe(v)]);
    return proto && proto !== "Object" ? { __type: proto, __string: String(value), ...Object.fromEntries(entries) } : Object.fromEntries(entries);
  }
  return value;
}
function typesOf(value: unknown) {
  if (!value || typeof value !== "object") return { __root: typeof value };
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v instanceof Uint8Array ? "Uint8Array" : Array.isArray(v) ? "array" : typeof v]));
}
function render() {
  try {
    localStorage.setItem(STORE, JSON.stringify(results));
  } catch {
    state.pageErrors.push("could not save results in this browser");
  }
  ($("output") as HTMLTextAreaElement).value = JSON.stringify({ ...state, requestsVisibleToPage: [...seenRequests], results }, null, 2);
  $("network").textContent = [...seenRequests].join("\n") || "(none yet)";
}

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) if (!entry.name.startsWith(location.origin)) seenRequests.add(entry.name);
  render();
}).observe({ type: "resource", buffered: true });

const connector = new NearConnector({ network: "mainnet", manifest, features: { signMessage: true } } as ConstructorParameters<typeof NearConnector>[0]);

for (const p of payloads) {
  const box = document.createElement("section");
  box.innerHTML = "<h3></h3><p>Recipient: <code></code></p><pre></pre><button disabled></button> <span class='status'></span>";
  box.querySelector("h3")!.textContent = p.label;
  box.querySelector("code")!.textContent = p.recipient;
  box.querySelector("pre")!.textContent = p.message;
  const button = box.querySelector("button")!;
  button.textContent = `Sign with recipient ${p.recipient}`;
  button.classList.add("sign");
  const status = box.querySelector("span")!;
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Waiting for Meteor...";
    const params = { message: p.message, recipient: p.recipient, nonce: Uint8Array.from(atob(p.nonce), (c) => c.charCodeAt(0)) };
    const entry: Result = { label: p.label, verifierRequested: p.recipient, ok: false, at: new Date().toISOString(), pending: true };
    // Recorded before the wallet is called, so a call that never returns is still visible.
    const index = results.findIndex((r) => r.label === p.label);
    if (index >= 0) results[index] = entry;
    else results.push(entry);
    render();
    try {
      const wallet = await connector.wallet();
      const output = await wallet.signMessage(params);
      entry.ok = true;
      entry.rawOutput = describe(output);
      entry.outputTypes = typesOf(output);
      status.textContent = "Signed";
    } catch (err) {
      entry.error = err instanceof Error ? `${err.name}: ${err.message}` : (JSON.stringify(err) ?? String(err));
      status.textContent = `Not signed: ${entry.error}`;
      button.disabled = false;
    }
    entry.pending = false;
    entry.returnedAt = new Date().toISOString();
    render();
  });
  const previous = results.find((r) => r.label === p.label);
  if (previous) status.textContent = previous.ok ? "Signed earlier (saved)" : `Earlier attempt: ${previous.error ?? "unknown"}`;
  $("payloads").append(box);
}

$("connect").addEventListener("click", async () => {
  $("account").textContent = "Connecting...";
  try {
    const wallet = await connector.connect({ walletId: "meteor-wallet" });
    const accounts = await wallet.getAccounts();
    state.connectedAccounts = accounts;
    $("account").textContent = `Connected: ${accounts[0]?.accountId ?? "(no account returned)"}`;
    document.querySelectorAll<HTMLButtonElement>("button.sign").forEach((b) => (b.disabled = false));
  } catch (err) {
    $("account").textContent = `Connect failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  render();
});
$("copy").addEventListener("click", async () => {
  render();
  await navigator.clipboard.writeText(($("output") as HTMLTextAreaElement).value);
  $("copied").textContent = "Copied";
});
render();
