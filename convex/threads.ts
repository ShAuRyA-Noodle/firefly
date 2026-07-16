// Threads ownership table: maps agent thread IDs to owning users.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedQuery } from "./lib/functions";

// Mirror of the agent-side cap. Kept duplicated rather than imported to
// avoid importing agent.ts (which pulls in heavy LLM/SDK init) from the
// queries-and-mutations file. If you change one, change the other.
const MAX_FRAMES_PER_THREAD = 4;

export const createThreadRecord = internalMutation({
  args: {
    agentThreadId: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, { agentThreadId, userId }) => {
    return await ctx.db.insert("threads", {
      agentThreadId,
      userId,
      createdAt: Date.now(),
    });
  },
});

/**
 * Create a branched thread row. Resolves the parent's thread row id so we
 * can index by it for the tree view.
 */
export const createBranchRecord = internalMutation({
  args: {
    agentThreadId: v.string(),
    userId: v.id("users"),
    parentAgentThreadId: v.string(),
    anchorFrameId: v.id("explanations"),
  },
  handler: async (
    ctx,
    { agentThreadId, userId, parentAgentThreadId, anchorFrameId },
  ) => {
    const parent = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) =>
        q.eq("agentThreadId", parentAgentThreadId),
      )
      .unique();
    return await ctx.db.insert("threads", {
      agentThreadId,
      userId,
      createdAt: Date.now(),
      parentThreadId: parent?._id,
      anchorFrameId,
    });
  },
});

export const getOwnerByAgentThread = internalQuery({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    return row ? row.userId : null;
  },
});

/** Set the thread title on first question — idempotent. */
export const setTitleIfUnset = internalMutation({
  args: { agentThreadId: v.string(), title: v.string() },
  handler: async (ctx, { agentThreadId, title }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row || row.title) return null;
    const trimmed = title.trim().replace(/\s+/g, " ").slice(0, 80);
    if (trimmed.length === 0) return null;
    await ctx.db.patch(row._id, { title: trimmed });
    return null;
  },
});

/**
 * Director announces the frame count it plans to dispatch. Stored on the
 * thread row so any sub-agent completing a render can check whether it's
 * the last one and insert the _done sentinel.
 */
export const setExpectedFrames = internalMutation({
  args: { agentThreadId: v.string(), expectedFrames: v.number() },
  handler: async (ctx, { agentThreadId, expectedFrames }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { expectedFrames });
    return null;
  },
});

/**
 * Reset per-question state so the next prompt on this thread starts fresh.
 * The agent-managed message history is untouched — only our app-level
 * "how many frames did the director plan" counter resets.
 */
export const resetThreadPlan = internalMutation({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      expectedFrames: undefined,
      doneMarkedAt: undefined,
      // Reset the dispatch counter so the next question starts with a
      // fresh slot budget. Without this, after the first question fills
      // the cap, every subsequent question would be rejected.
      inflightDispatched: undefined,
    });
    return null;
  },
});

/**
 * Atomic dispatch-slot reservation. Reads the thread's current
 * `inflightDispatched` count and bumps it iff under cap. Convex mutations
 * are serializable transactions so concurrent calls cannot oversubscribe.
 *
 * Returns `{ok: true, slot: N}` (1-indexed) when the caller now owns slot N,
 * or `{ok: false}` when the cap is full.
 *
 * The director's launchVisualAgent uses this in place of the old
 * countNonDoneForThread precheck, which had a race window: rapid parallel
 * launches each saw `existing < cap` because the corresponding explanation
 * rows hadn't been written yet, and the thread blew past the cap.
 */
export const tryDispatchSlot = internalMutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", threadId))
      .unique();
    if (!row) return { ok: false as const };
    const current = row.inflightDispatched ?? 0;
    if (current >= MAX_FRAMES_PER_THREAD) return { ok: false as const };
    const next = current + 1;
    await ctx.db.patch(row._id, { inflightDispatched: next });
    return { ok: true as const, slot: next };
  },
});

/**
 * DB-level idempotency probe used by renderVisual. Returns true when an
 * explanation row already exists for (threadId, step) that isn't a
 * sentinel/intro/tombstone — i.e. a real frame is already on disk.
 *
 * Combined with the per-runSubAgent `alreadyRendered` closure flag, this
 * makes renderVisual idempotent under: (a) primary partial success →
 * fallback retry that calls renderVisual again from a fresh closure,
 * (b) parallel duplicate dispatch from a misbehaving director, (c)
 * cron-style reruns of the sub-agent action.
 *
 * Co-located with the dispatcher rather than in explanations.ts because
 * it's about scheduling correctness, not explanation content. Gamma owns
 * explanations.ts; this is a Beta-owned scheduling primitive.
 */
export const existsRenderForStep = internalQuery({
  args: { threadId: v.string(), step: v.number() },
  handler: async (ctx, { threadId, step }) => {
    const rows = await ctx.db
      .query("explanations")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return rows.some(
      (r) =>
        r.step === step &&
        r.skill !== "_done" &&
        r.skill !== "intro" &&
        r.skill !== "_failed" &&
        !r.deletedAt,
    );
  },
});

export const getThreadPlan = internalQuery({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) return null;
    return {
      threadRowId: row._id,
      expectedFrames: row.expectedFrames ?? null,
      doneMarkedAt: row.doneMarkedAt ?? null,
    };
  },
});

/**
 * Public, ownership-checked list of the caller's threads, newest first.
 * Powers the profile history + the branch picker.
 */
export const listMine = authedQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = Math.min(limit ?? 30, 100);
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_user_created", (q) => q.eq("userId", ctx.userId))
      .order("desc")
      .take(cap);
    // Resolve parent thread metadata for each branch — the UI needs
    // "forked from X" in its list view.
    return await Promise.all(
      rows.map(async (r) => {
        let parentAgentThreadId: string | null = null;
        if (r.parentThreadId) {
          const p = await ctx.db.get(r.parentThreadId);
          parentAgentThreadId = p?.agentThreadId ?? null;
        }
        return {
          agentThreadId: r.agentThreadId,
          createdAt: r.createdAt,
          title: r.title ?? null,
          doneMarkedAt: r.doneMarkedAt ?? null,
          parentAgentThreadId,
          anchorFrameId: r.anchorFrameId ?? null,
        };
      }),
    );
  },
});

/**
 * Trail of ancestors for a branched thread — used for breadcrumb rendering.
 * Returns [root, ..., parent] in order. Empty for a root thread.
 */
export const ancestorTrail = authedQuery({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const trail: Array<{ agentThreadId: string; title: string | null }> = [];
    let cursor = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!cursor || cursor.userId !== ctx.userId) return [];
    let hops = 0;
    while (cursor?.parentThreadId && hops < 16) {
      const parent = await ctx.db.get(cursor.parentThreadId);
      if (!parent || parent.userId !== ctx.userId) break;
      trail.unshift({
        agentThreadId: parent.agentThreadId,
        title: parent.title ?? null,
      });
      cursor = parent;
      hops += 1;
    }
    return trail;
  },
});

/**
 * Public, auth + ownership checked. UI uses this to render the "N of M"
 * progress counter while sub-agents stream in.
 */
export const getMyThreadProgress = authedQuery({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) return null;
    if (row.userId !== ctx.userId) throw new Error("Forbidden");
    // Progress reflects the ACTIVE question (turn), whose settle state now
    // lives on the turn row. `currentTurnIndex` lets the UI scope its
    // "N of M" count to the current question's frames instead of the
    // thread's whole append-history.
    if (!row.currentTurnId) {
      return {
        expectedFrames: null,
        doneMarkedAt: null,
        currentTurnIndex: null,
      };
    }
    const turn = await ctx.db.get(row.currentTurnId);
    return {
      expectedFrames: turn?.expectedFrames ?? null,
      doneMarkedAt: turn?.doneMarkedAt ?? null,
      currentTurnIndex: turn?.turnIndex ?? null,
    };
  },
});

/**
 * Atomic "am I the last frame?" check + _done insert. Called from the
 * renderVisual write path — the sub-agent that brings actualFrames up to
 * expectedFrames inserts the sentinel exactly once (doneMarkedAt guard).
 *
 * Returns `{ marked: true }` if THIS call was the one that inserted the
 * sentinel, `{ marked: false }` otherwise. Callers use the flag to kick
 * off once-per-thread follow-up work (memory extraction, analytics).
 */
export const markDoneIfSettled = internalMutation({
  args: {
    agentThreadId: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, { agentThreadId, userId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) return { marked: false as const };
    if (row.doneMarkedAt) return { marked: false as const };
    if (!row.expectedFrames) return { marked: false as const };

    const frames = await ctx.db
      .query("explanations")
      .withIndex("by_thread", (q) => q.eq("threadId", agentThreadId))
      .collect();
    const actual = frames.filter(
      (f) => f.skill !== "_done" && f.skill !== "intro" && !f.deletedAt,
    ).length;
    if (actual < row.expectedFrames) return { marked: false as const };

    const now = Date.now();
    await ctx.db.insert("explanations", {
      threadId: agentThreadId,
      userId,
      skill: "_done",
      config: JSON.stringify({ totalFrames: actual }),
      createdAt: now,
    });
    await ctx.db.patch(row._id, { doneMarkedAt: now });
    return { marked: true as const };
  },
});
