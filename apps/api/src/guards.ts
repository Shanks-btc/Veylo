import { findActiveSession, getActiveMembership, type MembershipRole } from "@veylo/db";
import type { FastifyRequest } from "fastify";
import { sha256Hex, type Deps } from "./app.js";
import { forbidden, notFound, unauthenticated } from "./errors.js";

export const SESSION_COOKIE = "veylo_session";

export type Guards = ReturnType<typeof createGuards>;

export function createGuards(deps: Deps) {
  async function requireSession(request: FastifyRequest) {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw unauthenticated();
    const session = await findActiveSession(deps.db, sha256Hex(token), deps.clock());
    if (!session) throw unauthenticated();
    return session;
  }

  /** A non-member, including a removed member, gets 404: the org's existence isn't revealed. */
  async function requireMember(request: FastifyRequest, orgId: string) {
    const session = await requireSession(request);
    const membership = await getActiveMembership(deps.db, orgId, session.userId);
    if (!membership) throw notFound();
    return { session, membership };
  }

  /** A member whose role is too low already knows the org exists, so they get 403. */
  async function requireRole(
    request: FastifyRequest,
    orgId: string,
    roles: readonly MembershipRole[],
  ) {
    const member = await requireMember(request, orgId);
    if (!roles.includes(member.membership.role)) throw forbidden();
    return member;
  }

  return { requireSession, requireMember, requireRole };
}
