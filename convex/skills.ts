/**
 * Skills Queries and Mutations
 *
 * Tree-based skill system with progressive disclosure:
 * - Discovery: Only depth-0 categories returned for system prompt
 * - Category invoke: Parent content + child descriptions
 * - Skill invoke: Full instructions from skill_files
 */

import { query, mutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

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

export const listCategories = query({
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

export const getByName = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
  },
});

export const getChildren = query({
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

export const getFile = query({
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
// SYNC QUERIES (for sync script)
// =============================================================================

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("skills").collect();
  },
});

export const listAllFiles = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("skill_files").collect();
  },
});

// =============================================================================
// MUTATIONS (for sync script)
// =============================================================================

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
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();

    if (existing) await ctx.db.delete(existing._id);

    const files = await ctx.db
      .query("skill_files")
      .withIndex("by_skill", (q) => q.eq("skillName", args.name))
      .collect();

    for (const file of files) await ctx.db.delete(file._id);

    return { deleted: !!existing, filesDeleted: files.length };
  },
});

export const deleteFile = mutation({
  args: { secret: v.string(), skillName: v.string(), path: v.string() },
  handler: async (ctx, args) => {
    assertSyncSecret(args.secret);
    const existing = await ctx.db
      .query("skill_files")
      .withIndex("by_skill_path", (q) =>
        q.eq("skillName", args.skillName).eq("path", args.path)
      )
      .first();

    if (existing) await ctx.db.delete(existing._id);
    return { deleted: !!existing };
  },
});
