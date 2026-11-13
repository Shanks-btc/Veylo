"use client";
// The signed-in app's state: the typed API client (W1), who is signed in (GET /me), the selected
// organisation, the treasury wallet (loaded only when needed), and the theme. The session itself
// is the API's httpOnly cookie; only the org choice and the theme are kept in localStorage, each
// read and written inside try/catch so the app works without storage.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { meResponse } from "@veylo/contract";
import type { z } from "zod";
import { ApiError, createApiClient, type ApiClient } from "../api/client";
import { loadWebConfig, type WebConfig } from "../config";
import type { WalletSigner } from "../wallet/types";
import { isDemo, loadDemoWorld } from "../demo/load";
import type { GateRpc, HighWaterStore } from "../gates";

type Me = z.infer<typeof meResponse>;
export type Theme = "light" | "dark";

export const webConfig: WebConfig = loadWebConfig({
  NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN,
  NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEXT_PUBLIC_NEAR_RPC_URL,
  NEXT_PUBLIC_NEAR_ARCHIVAL_RPC_URL: process.env.NEXT_PUBLIC_NEAR_ARCHIVAL_RPC_URL,
  NEXT_PUBLIC_AUTH_RECIPIENT: process.env.NEXT_PUBLIC_AUTH_RECIPIENT,
  NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES: process.env.NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES,
  NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN: process.env.NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN,
});

export function storageGet(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
export function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage blocked: the choice just isn't remembered.
  }
}

const themeKey = (accountId: string | undefined) => `veylo.theme.${accountId ?? "signed-out"}`;
const ORG_KEY = "veylo.org";

export type ConnectedWallet = { signer: WalletSigner; accountId: string; publicKey?: string };

type Session = {
  api: ApiClient;
  config: WebConfig;
  /** undefined while loading; null when signed out. */
  me: Me | null | undefined;
  refreshMe: () => Promise<void>;
  orgId: string | undefined;
  setOrgId: (id: string) => void;
  wallet: ConnectedWallet | undefined;
  /**
   * Connects a wallet. With an id (from the picker; the Veylo wallet is EMBEDDED_ID) it connects that
   * one. Without an id it returns the connected wallet, or asks the person to choose one in the
   * picker (rendered by WalletPickerHost) and waits for the choice.
   */
  connectWallet: (walletId?: string, intent?: "create" | "restore") => Promise<ConnectedWallet>;
  setWallet: (w: ConnectedWallet | undefined) => void;
  /** Set while some action is waiting for the person to choose a wallet. */
  pickerOpen: boolean;
  finishPicker: (result: { wallet: ConnectedWallet } | { error: Error }) => void;
  /** The clock the gates and countdowns use: the real one, except in the demo (a fixed story time). */
  now: () => Date;
  /** What the browser gates need besides the wallet: NEAR RPC, the anti-rollback store, the time. */
  gateDeps: () => Promise<{
    rpc: GateRpc;
    highWater: HighWaterStore;
    now: Date;
    authRecipient: string;
  }>;
  theme: Theme;
  setTheme: (t: Theme) => void;
};

const SessionContext = createContext<Session | undefined>(undefined);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const api = useMemo(
    () =>
      createApiClient({
        origin: webConfig.apiOrigin,
        // The demo build answers from its in-browser world; everything else uses the real network.
        fetch: isDemo()
          ? (input, init) => loadDemoWorld().then((w) => w.fetch(input, init))
          : globalThis.fetch.bind(globalThis),
      }),
    [],
  );
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [orgId, setOrg] = useState<string | undefined>(undefined);
  const [wallet, setWallet] = useState<ConnectedWallet | undefined>(undefined);
  const [theme, setThemeState] = useState<Theme>("light");
  const connecting = useRef<Promise<ConnectedWallet> | undefined>(undefined);
  const waiting = useRef<{ resolve: (w: ConnectedWallet) => void; reject: (e: Error) => void }[]>(
    [],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const finishPicker = useCallback((result: { wallet: ConnectedWallet } | { error: Error }) => {
    const list = waiting.current;
    waiting.current = [];
    setPickerOpen(false);
    for (const w of list) "wallet" in result ? w.resolve(result.wallet) : w.reject(result.error);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const m = await api.call("GET /me");
      setMe(m);
      const saved = storageGet(ORG_KEY);
      const ids = m.memberships.map((x) => x.orgId);
      setOrg(saved && ids.includes(saved) ? saved : ids[0]);
      const t = storageGet(themeKey(m.user.nearAccountId ?? m.user.email ?? undefined));
      setThemeState(t === "dark" ? "dark" : "light");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setMe(null);
    }
  }, [api]);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);

  const setTheme = useCallback(
    (t: Theme) => {
      setThemeState(t);
      storageSet(themeKey(me?.user.nearAccountId ?? me?.user.email ?? undefined), t);
    },
    [me],
  );

  const setOrgId = useCallback((id: string) => {
    setOrg(id);
    storageSet(ORG_KEY, id);
  }, []);

  const connectWallet = useCallback(
    async (walletId?: string, intent?: "create" | "restore") => {
      if (wallet) return wallet;
      // No wallet and no choice yet: ask. The demo has one stand-in wallet and never asks.
      if (!walletId && !isDemo()) {
        return new Promise<ConnectedWallet>((resolve, reject) => {
          waiting.current.push({ resolve, reject });
          setPickerOpen(true);
        });
      }
      connecting.current ??= (async () => {
        if (isDemo()) {
          const world = await loadDemoWorld();
          const w: ConnectedWallet = { signer: world.wallet, ...(await world.wallet.connect()) };
          setWallet(w);
          return w;
        }
        // Wallet code runs on the bridge origin (L44); this app only verifies what comes back.
        const [{ createBridgeWallet }, { createFrameTransport }, { createGateRpc }, registry] =
          await Promise.all([
            import("../wallet/bridge-client"),
            import("../wallet/bridge-frame"),
            import("../gates/rpc"),
            import("../wallet/registry"),
          ]);
        const id = walletId;
        const known =
          id === registry.EMBEDDED_ID || registry.ENABLED_WALLETS.some((x) => x.id === id);
        if (!id || !known) throw new Error("Choose a wallet from the list.");
        const path = id === registry.EMBEDDED_ID ? registry.EMBEDDED_PATH : registry.bridgePath(id);
        const rpc = createGateRpc({
          url: webConfig.nearRpcUrl,
          fetch: globalThis.fetch.bind(globalThis),
        });
        const signer = createBridgeWallet({
          bridgeOrigin: webConfig.walletBridgeOrigin,
          transport: createFrameTransport(webConfig.walletBridgeOrigin, path),
          rpc,
        });
        const account = await signer.connect(intent);
        const w: ConnectedWallet = { signer, ...account };
        setWallet(w);
        return w;
      })().finally(() => {
        connecting.current = undefined;
      });
      return connecting.current;
    },
    [wallet],
  );

  const demoNow = useRef<(() => Date) | undefined>(undefined);
  useEffect(() => {
    if (isDemo()) void loadDemoWorld().then((w) => (demoNow.current = w.now));
  }, []);
  const now = useCallback(() => demoNow.current?.() ?? new Date(), []);
  const gateDeps = useCallback(async () => {
    if (isDemo()) {
      const w = await loadDemoWorld();
      return {
        rpc: w.gateRpc,
        highWater: w.highWater,
        now: w.now(),
        authRecipient: w.authRecipient,
      };
    }
    const [{ createGateRpc, createIndexedDbHighWater }] = await Promise.all([import("../gates")]);
    return {
      rpc: createGateRpc({ url: webConfig.nearRpcUrl, fetch: globalThis.fetch.bind(globalThis) }),
      highWater: createIndexedDbHighWater(),
      now: new Date(),
      authRecipient: webConfig.authRecipient,
    };
  }, []);

  const value = useMemo<Session>(
    () => ({
      api,
      config: webConfig,
      me,
      refreshMe,
      orgId,
      setOrgId,
      wallet,
      connectWallet,
      setWallet,
      pickerOpen,
      finishPicker,
      now,
      gateDeps,
      theme,
      setTheme,
    }),
    [
      api,
      me,
      refreshMe,
      orgId,
      setOrgId,
      wallet,
      connectWallet,
      pickerOpen,
      finishPicker,
      now,
      gateDeps,
      theme,
      setTheme,
    ],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The selected organisation's membership, if any. */
export function useOrg() {
  const { me, orgId } = useSession();
  return me?.memberships.find((m) => m.orgId === orgId);
}

/** Loads one API call; reload() runs it again. Errors are messages, never thrown into React. */
export function useApi<T>(load: (() => Promise<T>) | undefined, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!load) {
      setState({ loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (err: unknown) =>
        live &&
        setState({
          error: err instanceof Error ? err.message : "Something went wrong",
          loading: false,
        }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/**
 * Reads a query parameter in a static export (no server): undefined until read, null when absent
 * or not a plain id.
 */
export function useQueryParam(name: string): string | null | undefined {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get(name);
    setValue(v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
  }, [name]);
  return value;
}
