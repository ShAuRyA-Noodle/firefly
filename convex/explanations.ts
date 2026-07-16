// Explanation records with per-user ownership scoping.
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/functions";
import type { Id } from "./_generated/dataModel";

export const create = internalMutation({
  args: {
    threadId: v.string(),
    userId: v.id("users"),
    messageId: v.optional(v.string()),
    skill: v.string(),
    config: v.string(),
    narration: v.optional(v.string()),
    step: v.optional(v.number()),
    // The question this frame belongs to. Optional so the intro path and
    // legacy callers still work; the sub-agent render path always passes it
    // so dedup + settle scope to one question.
    turnId: v.optional(v.id("turns")),
    turnIndex: v.optional(v.number()),
    parentId: v.optional(v.id("explanations")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("explanations", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

// Resolve the owning userId for a given explanation. Used by downstream
// async actions (TTS, future export jobs) that need per-user rate limiting
// without re-authenticating through the caller's identity.
export const getOwner = internalQuery({
  args: { explanationId: v.id("explanations") },
  handler: async (ctx, { explanationId }): Promise<Id<"users"> | null> => {
    const row = await ctx.db.get(explanationId);
    return row ? row.userId : null;
  },
});

// Soft-delete a single explanation. The row remains so branches that
// referenced it stay consistent; getByThread filters out tombstoned rows.
// Authenticated + ownership-checked.
//
// Storage hygiene: if the row carried a synthesized audio blob, drop it
// before tombstoning. Storage growth was previously unbounded since the
// row reference disappeared from active queries but the underlying blob
// stayed pinned forever — bytes leak per soft-delete. Right-to-erasure
// also progresses: the blob is gone even though the row stays for branch
// referential integrity. Failures here are logged, never block tombstone.
export const softDelete = authedMutation({
  args: { explanationId: v.id("explanations") },
  handler: async (ctx, { explanationId }) => {
    const row = await ctx.db.get(explanationId);
    if (!row) throw new Error("Not found");
    if (row.userId !== ctx.userId) throw new Error("Forbidden");
    if (row.audioStorageId) {
      try {
        await ctx.storage.delete(row.audioStorageId);
      } catch (err) {
        console.warn(
          `[explanations.softDelete] storage.delete failed for ${row.audioStorageId}: ${
            err instanceof Error ? err.message : String(err)
          } — proceeding with tombstone`,
        );
      }
    }
    await ctx.db.patch(explanationId, { deletedAt: Date.now() });
    return null;
  },
});

export const patchAudio = internalMutation({
  args: {
    explanationId: v.id("explanations"),
    audioStorageId: v.id("_storage"),
    audioTimings: v.string(),
  },
  handler: async (ctx, { explanationId, audioStorageId, audioTimings }) => {
    await ctx.db.patch(explanationId, { audioStorageId, audioTimings });
  },
});

export const markDone = internalMutation({
  args: {
    threadId: v.string(),
    userId: v.id("users"),
    totalFrames: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("explanations", {
      threadId: args.threadId,
      userId: args.userId,
      skill: "_done",
      config: JSON.stringify({ totalFrames: args.totalFrames }),
      createdAt: Date.now(),
    });
  },
});

export const getByThread = authedQuery({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    const explanations = await ctx.db
      .query("explanations")
      .withIndex("by_user_thread", (q) =>
        q.eq("userId", ctx.userId).eq("threadId", args.threadId)
      )
      .collect();

    // Filter tombstones — soft-deleted rows are kept for branch-reference
    // consistency but should never surface in the UI.
    const live = explanations.filter((e) => !e.deletedAt);

    // Append-history order: questions in ask-order (turnIndex), frames within
    // a question in narrative order (step), and each question's _done sentinel
    // after its frames. Legacy rows (no turnIndex) sort first as one group.
    const orderKey = (e: (typeof live)[number]) => {
      const turn = e.turnIndex ?? 0;
      const isDone = e.skill === "_done" ? 1 : 0;
      const step = e.step ?? 0;
      return [turn, isDone, step, e.createdAt] as const;
    };
    live.sort((a, b) => {
      const ka = orderKey(a);
      const kb = orderKey(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      }
      return 0;
    });

    // Only hit storage for rows that actually have an audio blob. getUrl on a
    // real id is O(1) but every avoided call still saves a round-trip; doing
    // them in parallel keeps the query latency bounded by the slowest single
    // resolution, not the count.
    return Promise.all(
      live.map(async (exp) => {
        if (!exp.audioStorageId) return exp;
        const audioUrl = await ctx.storage.getUrl(exp.audioStorageId);
        return { ...exp, audioUrl: audioUrl ?? exp.audioUrl };
      })
    );
  },
});

// Internal counter used by the director agent's hard frame cap.
export const countNonDoneForThread = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const rows = await ctx.db
      .query("explanations")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return rows.filter(
      (r) => r.skill !== "_done" && r.skill !== "intro" && !r.deletedAt,
    ).length;
  },
});

export const getByMessage = authedQuery({
  args: { messageId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("explanations")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .collect();

    for (const r of rows) {
      if (r.userId !== ctx.userId) throw new Error("Forbidden");
    }

    const live = rows.filter((r) => !r.deletedAt);
    return Promise.all(
      live.map(async (exp) => {
        if (!exp.audioStorageId) return exp;
        const audioUrl = await ctx.storage.getUrl(exp.audioStorageId);
        return { ...exp, audioUrl: audioUrl ?? exp.audioUrl };
      })
    );
  },
});
