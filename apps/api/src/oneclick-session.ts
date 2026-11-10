// The org's 1Click User-Session (rule 7, T-10, L30): tokens decrypted only here, refreshed
// server-side, never logged or returned.
import { TREASURY_ASSET_ID } from "@veylo/core";
import {
  findOneClickSession,
  getOrCreateWrappedDataKey,
  markOneClickSessionNeedsResign,
  updateOneClickAccessToken,
} from "@veylo/db";
import { OneClickError } from "@veylo/intents";
import type { FastifyBaseLogger } from "fastify";
import type { Deps } from "./app.js";

export const ACCESS = "oneclick.access";
export const REFRESH = "oneclick.refresh";

export function createSessionAccess(deps: Deps) {
  /** A usable access token, refreshing server-side. Undefined means the wallet must sign again. */
  async function accessToken(log: FastifyBaseLogger, orgId: string): Promise<string | undefined> {
    const row = await findOneClickSession(deps.db, orgId);
    if (!row || row.status !== "active") return undefined;
    const now = deps.clock();
    const wrapped = await getOrCreateWrappedDataKey(deps.db, orgId, () =>
      deps.secrets.newWrappedDataKey(orgId),
    );
    const recordId = row.id;
    if (row.accessExpiresAt.getTime() > now.getTime()) {
      return deps.secrets.decrypt(
        wrapped,
        { orgId, purpose: ACCESS, recordId },
        row.encryptedAccessToken,
      );
    }
    if (row.refreshExpiresAt.getTime() <= now.getTime()) {
      await markOneClickSessionNeedsResign(deps.db, orgId);
      return undefined;
    }
    const refreshToken = deps.secrets.decrypt(
      wrapped,
      { orgId, purpose: REFRESH, recordId },
      row.encryptedRefreshToken,
    );
    try {
      const fresh = await deps.oneclickTreasury.refresh(refreshToken);
      await updateOneClickAccessToken(deps.db, orgId, {
        encryptedAccessToken: deps.secrets.encrypt(
          wrapped,
          { orgId, purpose: ACCESS, recordId },
          fresh.accessToken,
        ),
        accessExpiresAt: new Date(now.getTime() + fresh.expiresIn * 1000),
      });
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof OneClickError && err.kind === "unauthorized") {
        await markOneClickSessionNeedsResign(deps.db, orgId);
        return undefined;
      }
      log.warn({ err }, "1Click token refresh failed");
      throw err;
    }
  }

  /** The confidential USDC balance, or why it can't be read. Never a guessed number. */
  async function confidentialBalance(
    log: FastifyBaseLogger,
    orgId: string,
  ): Promise<{ status: "ok"; amount: string } | { status: "needs_session" | "error" }> {
    try {
      const token = await accessToken(log, orgId);
      if (token === undefined) return { status: "needs_session" };
      const { balances } = await deps.oneclickTreasury.balances(token);
      // The docs: only non-zero balances are listed, so a missing token is a real zero.
      return {
        status: "ok",
        amount: balances.find((b) => b.tokenId === TREASURY_ASSET_ID)?.available ?? "0",
      };
    } catch (err) {
      if (err instanceof OneClickError && err.kind === "unauthorized") {
        await markOneClickSessionNeedsResign(deps.db, orgId);
        return { status: "needs_session" };
      }
      log.warn({ err }, "confidential balance read failed");
      return { status: "error" };
    }
  }

  return { accessToken, confidentialBalance };
}
