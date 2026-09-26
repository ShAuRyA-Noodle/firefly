/**
 * User memory: compact, human-readable one-liners summarizing what the user
 * has asked about and which concepts got taught. Written once per completed
 * thread by the extractor action (see memoryExtract.ts). Read by the
 * director on new questions to inject prior-context awareness into its plan.
 *
 * Kept deliberately small (few rows, short strings) so the director's
 * context window stays fast — this is a "breadcrumb trail", not full RAG.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedQuery } from "./lib/functions";

export const insertMemory = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.string(),
    turnId: v.optional(v.id("turns")),
    summary: v.string(),
    concepts: v.array(v.string()),
  },
  handler: async (ctx, { userId, threadId, turnId, summary, concepts }) => {
    // Skip dupes — the extractor can fire twice if a turn is re-settled under
    // a race. Dedup on the turn when we have one (the live path always does),
    // so each question gets exactly one memory even though a thread holds
    // many. Fall back to thread-level dedup only for legacy/turn-less callers.
    if (turnId) {
      const existing = await ctx.db
        .query("user_memories")
        .withIndex("by_turn", (q) => q.eq("turnId", turnId))
        .first();
      if (existing) return existing._id;
    } else {
      const existing = await ctx.db
        .query("user_memories")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .first();
      if (existing) return existing._id;
    }
    return await ctx.db.insert("user_memories", {
      userId,
      threadId,
      turnId,
      summary,
      concepts,
      createdAt: Date.now(),
    });
  },
});

/** Most recent N memories for a user — for director prompt injection. */
export const recentForUser = internalQuery({
  args: {
    userId: v.id("users"),
    limit: v.number(),
  },
  handler: async (ctx, { userId, limit }) => {
    const rows = await ctx.db
      .query("user_memories")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .take(Math.min(limit, 20));
    return rows.map((r) => ({
      summary: r.summary,
      concepts: r.concepts,
      createdAt: r.createdAt,
    }));
  },
});

/** Public — profile page shows the user their own memory trail. */
export const listMine = authedQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = Math.min(limit ?? 50, 200);
    return await ctx.db
      .query("user_memories")
      .withIndex("by_user_created", (q) => q.eq("userId", ctx.userId))
      .order("desc")
      .take(cap);
  },
});

/** Concept aggregation for the skill tree view. */
export const topConceptsForUser = internalQuery({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, { userId, limit }) => {
    const rows = await ctx.db
      .query("user_concept_progress")
      .withIndex("by_user_concept", (q) => q.eq("userId", userId))
      .collect();
    rows.sort((a, b) => b.exposures - a.exposures);
    return rows.slice(0, Math.min(limit, 64));
  },
});

