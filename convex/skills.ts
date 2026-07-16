/**
 * Skills Queries and Mutations
 *
 * Tree-based skill system with progressive disclosure:
 * - Discovery: Only depth-0 categories returned for system prompt
 * - Category invoke: Parent content + child descriptions
 * - Skill invoke: Full instructions from skill_files
 *
 * IP-LOCK: All public queries require auth. Skill instructions are the
 * core IP of the agent; without auth-gating, the entire prompt corpus is
 * exfiltrable through `api.skills.list` + `api.skills.listAllFiles` from
 * any anonymous browser tab. Internal queries remain unauthed because they
 * run with system-caller identity from the agent tools (no user identity
 * to check).
 *
 * Mutations (sync upserts/deletes) gate on `SKILLS_ADMIN_USER_IDS` env, a
 * comma-separated allowlist of user ids. In dev (`CONVEX_DEPLOYMENT`
 * starts with `dev:`) we permit any authed caller so local development
 * is friction-free; in prod the env var must be set or the call throws.
 * This blocks an attacker who acquired any normal user's credentials from
 * vandalizing the production skill corpus via the public `mutation` API.
 */

import { internalQuery, query, mutation } from "./_generated/server";
import { authedQuery } from "./lib/functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// =============================================================================
// SECRET GATES
// =============================================================================
//
// Two distinct gates protect the skills surface:
//
//   assertSkillsAdmin  — for an *authenticated* admin who edits via UI/CLI
//                        signed in as themselves. Reads SKILLS_ADMIN_USER_IDS.
//                        Currently unused at runtime; kept for future.
//
//   assertSyncSecret   — for the *unauthenticated* sync script that runs in
//                        CI / on a maintainer's laptop and ships the
//                        skills/visual/* tree to Convex. Reads
//                        SKILLS_SYNC_SECRET. The script passes the secret as
//                        a function arg; the server compares with timing-safe
//                        equality. This avoids the chicken-and-egg of auth-
//                        gating a path that runs before any user exists, and
//                        it sidesteps "have to mint a JWT for CI" entirely.
//
// Dev-fallback for both: when CONVEX_DEPLOYMENT starts with "dev:" and the
// relevant env is unset, permit the call. Production deploys without the env
// hard-fail rather than silently no-op, so a misconfigured rollout is loud.

function assertSkillsAdmin(userId: Id<"users">): void {
  const adminEnv = process.env.SKILLS_ADMIN_USER_IDS ?? "";
  const admins = adminEnv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (admins.length > 0) {
    if (!admins.includes(userId)) {
      throw new Error("Forbidden: not a skills admin");
    }
    return;
  }
  const deployment = process.env.CONVEX_DEPLOYMENT ?? "";
  if (!deployment.startsWith("dev:")) {
    throw new Error(
      "Forbidden: SKILLS_ADMIN_USER_IDS unset on a non-dev deployment",
    );
  }
}

// Suppress "unused" warning on the admin helper while we keep it for future
// admin UI work — touching it here means renaming it would require refactor.
void assertSkillsAdmin;

// =============================================================================
// SYNC AUTHORIZATION
// =============================================================================

/**
 * Constant-time string comparison to avoid leaking the secret via timing.
 * Node's crypto.timingSafeEqual is unavailable in the default Convex runtime
 * (mutations cannot use "use node"), so we compare manually. We always walk
 * the full length of the provided secret to keep the time independent of how
 * many leading characters happen to match.
 */
function constantTimeEqual(a: string, b: string): boolean {
  let mismatch = a.length === b.length ? 0 : 1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Guards the sync mutations. The skill specs drive the agent's behavior, so
 * unauthenticated write access is an integrity / prompt-injection risk. The
 * sync script (src/scripts/skills/sync.ts) passes SKILLS_SYNC_SECRET, which
 * must be configured in the Convex deployment environment.
 */
function assertSyncSecret(secret: string): void {
  const expected = process.env.SKILLS_SYNC_SECRET;
  if (!expected) {
    throw new Error(
      "SKILLS_SYNC_SECRET is not configured in the Convex environment"
    );
  }
  if (!constantTimeEqual(secret, expected)) {
    throw new Error("Unauthorized: invalid skills sync secret");
  }
}

// =============================================================================
// DISCOVERY (Lean prompt - depth-0 categories only)
// =============================================================================

export const listCategories = authedQuery({
  args: {},
  handler: async (ctx) => {
    const categories = await ctx.db
      .query("skills")
      .withIndex("by_depth", (q) => q.eq("depth", 0))
      .collect();

    return categories.map((s) => ({
      name: s.name,
      description: s.description,
      hasChildren: s.hasChildren,
    }));
  },
});

// =============================================================================
// SKILL INVOCATION
// =============================================================================

export const getByName = authedQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
  },
});

export const getChildren = authedQuery({
  args: { parentName: v.string() },
  handler: async (ctx, args) => {
    const children = await ctx.db
      .query("skills")
      .withIndex("by_parent", (q) => q.eq("parentSkillName", args.parentName))
      .collect();

    return children.map((s) => ({
      name: s.name,
      description: s.description,
      hasChildren: s.hasChildren,
      depth: s.depth,
    }));
  },
});

export const getFile = authedQuery({
  args: { skillName: v.string(), path: v.string() },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("skill_files")
      .withIndex("by_skill_path", (q) =>
        q.eq("skillName", args.skillName).eq("path", args.path)
      )
      .first();
    return file?.content ?? null;
  },
});

// =============================================================================
// INTERNAL QUERIES (for agent tools)
// =============================================================================

export const get = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
  },
});

export const getFileInternal = internalQuery({
  args: { skillName: v.string(), path: v.string() },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("skill_files")
      .withIndex("by_skill_path", (q) =>
        q.eq("skillName", args.skillName).eq("path", args.path)
      )
      .first();
    return file?.content ?? null;
  },
});

export const getChildrenInternal = internalQuery({
  args: { parentName: v.string() },
  handler: async (ctx, args) => {
    const children = await ctx.db
      .query("skills")
      .withIndex("by_parent", (q) => q.eq("parentSkillName", args.parentName))
      .collect();

    return children.map((s) => ({
      name: s.name,
      description: s.description,
      hasChildren: s.hasChildren,
      depth: s.depth,
    }));
  },
});

// =============================================================================
// SYNC SURFACE (sync-secret gated, NOT auth-gated)
// =============================================================================
//
// These run from the unauthenticated `bun run skills:sync` CLI. They take a
// `secret` arg the script reads from SKILLS_SYNC_SECRET env on its side and
// the server compares constant-time. List/listAllFiles are also gated to keep
// the IP-corpus from leaking to anonymous browser tabs that grab the
// generated `api` object.

export const list = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    assertSyncSecret(secret);
    return await ctx.db.query("skills").collect();
  },
});

export const listAllFiles = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    assertSyncSecret(secret);
    return await ctx.db.query("skill_files").collect();
  },
});

export const upsert = mutation({
  args: {
    secret: v.string(),
    name: v.string(),
    description: v.string(),
    domains: v.array(v.string()),
    parentSkillName: v.optional(v.string()),
    depth: v.number(),
    hasChildren: v.boolean(),
    filePath: v.string(),
    contentHash: v.string(),
  },
  handler: async (ctx, args) => {
    assertSyncSecret(args.secret);
    const { secret, ...fields } = args;

    const existing = await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", fields.name))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, syncedAt: Date.now() });
      return { action: "updated" as const, id: existing._id };
    } else {
      const id = await ctx.db.insert("skills", {
        ...fields,
        syncedAt: Date.now(),
      });
      return { action: "created" as const, id };
    }
  },
});

export const upsertFile = mutation({
  args: {
    secret: v.string(),
    skillName: v.string(),
    path: v.string(),
    content: v.string(),
    contentHash: v.string(),
  },
  handler: async (ctx, args) => {
    assertSyncSecret(args.secret);
    const { secret, ...fields } = args;

    const existing = await ctx.db
      .query("skill_files")
      .withIndex("by_skill_path", (q) =>
        q.eq("skillName", fields.skillName).eq("path", fields.path)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: fields.content,
        contentHash: fields.contentHash,
        syncedAt: Date.now(),
      });
      return { action: "updated" as const };
    } else {
      await ctx.db.insert("skill_files", { ...fields, syncedAt: Date.now() });
      return { action: "created" as const };
    }
  },
});

export const deleteByName = mutation({
  args: { secret: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    assertSyncSecret(args.secret);
    const { name } = args;
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    if (existing) await ctx.db.delete(existing._id);

    const files = await ctx.db
      .query("skill_files")
      .withIndex("by_skill", (q) => q.eq("skillName", name))
      .collect();

    for (const file of files) await ctx.db.delete(file._id);

    return { deleted: !!existing, filesDeleted: files.length };
  },
});

export const deleteFile = mutation({
  args: { secret: v.string(), skillName: v.string(), path: v.string() },
  handler: async (ctx, args) => {
    assertSyncSecret(args.secret);
    const { skillName, path } = args;
    const existing = await ctx.db
      .query("skill_files")
      .withIndex("by_skill_path", (q) =>
        q.eq("skillName", skillName).eq("path", path)
      )
      .first();

    if (existing) await ctx.db.delete(existing._id);
    return { deleted: !!existing };
  },
});
