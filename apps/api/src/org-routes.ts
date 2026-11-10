import {
  createOrganization,
  findOrCreateUser,
  getActiveMembership,
  getActiveMembershipByAccount,
  getMembership,
  getOrganization,
  insertMembership,
  listActiveMembers,
  lockActiveOwners,
  markMemberRemoved,
  reactivateMembership,
  schema,
  setMemberRole,
  writeAudit,
  type Db,
} from "@veylo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { nearAccountId } from "./auth-routes.js";
import { conflict, forbidden, notFound } from "./errors.js";
import type { Guards } from "./guards.js";

const role = z.enum(schema.membershipRoleEnum.enumValues);
const orgParams = z.object({ orgId: z.uuid() });
const memberParams = z.object({ orgId: z.uuid(), userId: z.uuid() });
const createOrgBody = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const addMemberBody = z.object({ nearAccountId, role }).strict();
const changeRoleBody = z.object({ role }).strict();

const OWNER_ONLY = ["owner"] as const;

export async function orgRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  /**
   * Runs an owner's change to a member under a lock on the org's owners, re-checking inside it, so
   * concurrent demotions or removals can't leave the org with no owner.
   */
  function changeMember(
    orgId: string,
    actorId: string,
    targetId: string,
    keepsOwner: boolean,
    apply: (tx: Db) => Promise<void>,
  ) {
    return deps.db.transaction(async (tx) => {
      const owners = await lockActiveOwners(tx, orgId);
      if (!owners.some((o) => o.userId === actorId)) throw forbidden();
      const target = await getActiveMembership(tx, orgId, targetId);
      if (!target) throw notFound();
      if (target.role === "owner" && !keepsOwner && owners.length <= 1) {
        throw conflict("LAST_OWNER", "An organization must keep at least one active owner");
      }
      // L30: the treasury account signs payees and shields, so it must stay an owner.
      if (!keepsOwner) {
        const org = await getOrganization(tx, orgId);
        const treasury =
          org && (await getActiveMembershipByAccount(tx, orgId, org.treasuryAccountId));
        if (treasury?.userId === targetId) {
          throw conflict(
            "TREASURY_MEMBER",
            "The treasury account's membership can't be removed or demoted",
          );
        }
      }
      await apply(tx);
    });
  }

  app.post("/orgs", async (request, reply) => {
    const session = await guards.requireSession(request);
    const { name } = parse(createOrgBody, request.body);
    const org = await deps.db.transaction(async (tx) => {
      const created = await createOrganization(tx, {
        name,
        // The treasury is the owner's NEAR account (ARCHITECTURE §5).
        treasuryAccountId: session.nearAccountId,
        ownerUserId: session.userId,
      });
      await writeAudit(tx, {
        orgId: created.id,
        actor: session.userId,
        action: "org.create",
        entity: "organization",
        entityId: created.id,
        at: deps.clock(),
      });
      return created;
    });
    return reply.status(201).send({
      id: org.id,
      name: org.name,
      treasuryAccountId: session.nearAccountId,
    });
  });

  app.get("/orgs/:orgId", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireMember(request, orgId);
    const org = await getOrganization(deps.db, orgId);
    if (!org) throw notFound();
    return org;
  });

  app.get("/orgs/:orgId/members", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireMember(request, orgId);
    return { members: await listActiveMembers(deps.db, orgId) };
  });

  app.post("/orgs/:orgId/members", async (request, reply) => {
    const { orgId } = parse(orgParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(addMemberBody, request.body);
    const userId = await deps.db.transaction(async (tx) => {
      const user = await findOrCreateUser(tx, body.nearAccountId);
      const existing = await getMembership(tx, orgId, user.id);
      if (existing?.status === "active") {
        throw conflict("ALREADY_MEMBER", "This account is already a member");
      }
      if (existing) {
        await reactivateMembership(tx, orgId, user.id, body.role);
      } else if (!(await insertMembership(tx, orgId, user.id, body.role))) {
        throw conflict("ALREADY_MEMBER", "This account is already a member");
      }
      await writeAudit(tx, {
        orgId,
        actor: session.userId,
        action: "member.add",
        entity: "membership",
        entityId: user.id,
        at: deps.clock(),
      });
      return user.id;
    });
    return reply.status(201).send({ userId, nearAccountId: body.nearAccountId, role: body.role });
  });

  app.patch("/orgs/:orgId/members/:userId", async (request) => {
    const { orgId, userId } = parse(memberParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(changeRoleBody, request.body);
    await changeMember(orgId, session.userId, userId, body.role === "owner", async (tx) => {
      await setMemberRole(tx, orgId, userId, body.role);
      await writeAudit(tx, {
        orgId,
        actor: session.userId,
        action: "member.role_change",
        entity: "membership",
        entityId: userId,
        at: deps.clock(),
      });
    });
    return { userId, role: body.role };
  });

  app.post("/orgs/:orgId/members/:userId/remove", async (request) => {
    const { orgId, userId } = parse(memberParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const now = deps.clock();
    await changeMember(orgId, session.userId, userId, false, async (tx) => {
      await markMemberRemoved(tx, orgId, userId, now);
      await writeAudit(tx, {
        orgId,
        actor: session.userId,
        action: "member.remove",
        entity: "membership",
        entityId: userId,
        at: now,
      });
    });
    return { ok: true };
  });
}
