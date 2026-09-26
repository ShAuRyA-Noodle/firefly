/**
 * Per-question "turn" lifecycle.
 *
 * A thread hosts many questions over its life: the first prompt plus every
 * ActionCard follow-up the user taps. Each question is one `turns` row that
 * owns the per-question settle counters (dispatched-slot count, expected
 * frame count, done sentinel). Frames stamp their `turnId`, so counting,
 * dedup, and settle all scope to a single question.
 *
 * This replaces the old thread-row-level counters, which were single-valued
 * and therefore:
 *   (a) rejected every follow-up frame — question 2's step 1 collided with
 *       question 1's step 1 on the (threadId, step) dedup, and
 *   (b) settled prematurely — the cumulative frame count was already >= the
 *       new plan's expected count the instant the follow-up started.
 *
 * `turnId` is the `turns` row `_id`. `expectedFrames` is frozen from the
 * ACTUAL dispatched-slot count (not the LLM-announced total) so a director
 * miscount can never strand a turn.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// Hard cap on frames per question. Mirrors the director's own cap in
// agent.ts (kept duplicated to avoid importing the heavy LLM/SDK module
// from this queries-and-mutations file). If you change one, change both.
export const MAX_FRAMES_PER_THREAD = 4;

// Rows that don't count as "real rendered frames" for dispatch/settle math.
// _failed is intentionally NOT excluded — a failed-frame tombstone still
// occupies its slot and must count toward the settle target so a turn with
// a dead frame can still reach done() instead of hanging forever.
function isRealFrame(skill: string): boolean {
  return skill !== "_done" && skill !== "intro";
}

/**
 * Begin a new question on a thread. Allocates the next monotonic turnIndex,
 * inserts the turn row, and points the thread at it so the dispatch path
 * (which only has the agentThreadId) can find the active turn.
 */
export const startTurn = internalMutation({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!thread) {
      throw new Error(`startTurn: no thread for ${agentThreadId}`);
    }

    const latest = await ctx.db
      .query("turns")
      .withIndex("by_thread_index", (q) => q.eq("threadId", agentThreadId))
      .order("desc")
      .first();
    const turnIndex = (latest?.turnIndex ?? 0) + 1;

    const turnId = await ctx.db.insert("turns", {
      threadId: agentThreadId,
      userId: thread.userId,
      turnIndex,
      inflightDispatched: 0,
      createdAt: Date.now(),
    });

    await ctx.db.patch(thread._id, { currentTurnId: turnId });
    return { turnId, turnIndex };
  },
});

/**
 * Atomic dispatch-slot reservation for the thread's ACTIVE turn. Convex
 * mutations are serializable, so concurrent launches cannot oversubscribe.
 * Returns the turn identity alongside the slot so the caller can thread it
 * through to the scheduled sub-agent (rather than re-reading it at render
 * time, which would race a fast follow-up question).
 */
export const tryDispatchSlot = internalMutation({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!thread?.currentTurnId) return { ok: false as const };

    const turn = await ctx.db.get(thread.currentTurnId);
    if (!turn) return { ok: false as const };
    if (turn.inflightDispatched >= MAX_FRAMES_PER_THREAD) {
      return { ok: false as const };
    }
    const slot = turn.inflightDispatched + 1;
    await ctx.db.patch(turn._id, { inflightDispatched: slot });
    return {
      ok: true as const,
      slot,
      turnId: turn._id,
      turnIndex: turn.turnIndex,
    };
  },
});

/** Resolve the thread's active turn (for the director's done() tool). */
export const getCurrentTurn = internalQuery({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!thread?.currentTurnId) return null;
    const turn = await ctx.db.get(thread.currentTurnId);
    if (!turn) return null;
    return { turnId: turn._id, turnIndex: turn.turnIndex };
  },
});

/**
 * Freeze the expected frame count for a turn from the number of slots the
 * director actually reserved. Called by the director's done() tool. Deriving
 * from dispatch (not the LLM's announced total) means the turn settles when
 * the frames it truly dispatched all land — no stall on a miscount, no
 * premature settle on an over-count.
 */
export const setExpectedFramesFromDispatch = internalMutation({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn) return { expectedFrames: 0 };
    await ctx.db.patch(turnId, { expectedFrames: turn.inflightDispatched });
    return { expectedFrames: turn.inflightDispatched };
  },
});

/**
 * Safety net for a director that ends — or throws — WITHOUT calling done().
 * That left expectedFrames unset, so markDoneIfSettled early-returned forever
 * and the UI hung on "generating" with no way out. Sealing the turn against
 * the slots it actually dispatched lets the normal settle path close it.
 */
export const sealTurn = internalMutation({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn || turn.doneMarkedAt) return null;
    if (turn.expectedFrames === undefined) {
      await ctx.db.patch(turnId, { expectedFrames: turn.inflightDispatched });
    }
    return null;
  },
});

/**
 * DB idempotency probe: is there already a real frame at (turnId, step)?
 * Scoped to the turn, so the same step number in a later question is never
 * mistaken for an already-rendered frame.
 */
export const existsRenderForTurnStep = internalQuery({
  args: { turnId: v.id("turns"), step: v.number() },
  handler: async (ctx, { turnId, step }) => {
    const rows = await ctx.db
      .query("explanations")
      .withIndex("by_turn", (q) => q.eq("turnId", turnId))
      .collect();
    return rows.some(
      (r) => r.step === step && isRealFrame(r.skill) && !r.deletedAt,
    );
  },
});

/**
 * Insert the per-turn _done sentinel exactly once, when the turn's landed
 * frame count reaches its expected count. Returns { marked: true, ... } only
 * for the single call that inserted it — the caller uses that to fire
 * once-per-turn follow-up work (memory extraction).
 */
export const markDoneIfSettled = internalMutation({
  args: { turnId: v.id("turns"), userId: v.id("users") },
  handler: async (ctx, { turnId, userId }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn) return { marked: false as const };
    if (turn.doneMarkedAt) return { marked: false as const };
    if (turn.expectedFrames === undefined) return { marked: false as const };

    const frames = await ctx.db
      .query("explanations")
      .withIndex("by_turn", (q) => q.eq("turnId", turnId))
      .collect();
    const actual = frames.filter(
      (f) => isRealFrame(f.skill) && !f.deletedAt,
    ).length;
    if (actual < turn.expectedFrames) return { marked: false as const };

    const now = Date.now();
    await ctx.db.insert("explanations", {
      threadId: turn.threadId,
      userId,
      skill: "_done",
      config: JSON.stringify({ totalFrames: actual }),
      turnId,
      turnIndex: turn.turnIndex,
      createdAt: now,
    });
    await ctx.db.patch(turnId, { doneMarkedAt: now });
    return {
      marked: true as const,
      threadId: turn.threadId,
      turnId,
      turnIndex: turn.turnIndex,
    };
  },
});

/**
 * Settle-sweep: finalize turns that announced an expected frame count but
 * never reached it (a sub-agent died before writing and before laying a
 * _failed tombstone, or done() fired against a lost dispatch). Any open turn
 * older than `olderThan` ms with expectedFrames set is force-closed by
 * inserting its _done sentinel against the frames that DID land, so the UI
 * unsticks and downstream memory extraction can run.
 *
 * Returns the settled turns so the calling cron action can schedule memory
 * extraction for each — this mutation stays free of the (action-only) LLM
 * coupling.
 */
export const finalizeStalledTurns = internalMutation({
  args: { olderThan: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { olderThan, limit }) => {
    const cutoff = Date.now() - olderThan;
    const cap = Math.min(limit ?? 25, 100);

    const open = await ctx.db
      .query("turns")
      .withIndex("by_open", (q) => q.eq("doneMarkedAt", undefined))
      .take(500);

    const settled: Array<{
      threadId: string;
      turnId: typeof open[number]["_id"];
      userId: typeof open[number]["userId"];
      turnIndex: number;
    }> = [];

    for (const turn of open) {
      if (settled.length >= cap) break;
      if (turn.createdAt > cutoff) continue;
      // NOTE: do NOT skip turns with expectedFrames === undefined. That is
      // precisely the hung case — the director died before done() — and
      // skipping it left the UI generating forever. Finalize against whatever
      // actually landed.

      const frames = await ctx.db
        .query("explanations")
        .withIndex("by_turn", (q) => q.eq("turnId", turn._id))
        .collect();
      const actual = frames.filter(
        (f) => isRealFrame(f.skill) && !f.deletedAt,
      ).length;

      const now = Date.now();
      await ctx.db.insert("explanations", {
        threadId: turn.threadId,
        userId: turn.userId,
        skill: "_done",
        config: JSON.stringify({ totalFrames: actual, stalled: true }),
        turnId: turn._id,
        turnIndex: turn.turnIndex,
        createdAt: now,
      });
      await ctx.db.patch(turn._id, { doneMarkedAt: now });
      // Kick the once-per-turn memory extraction that a normal settle would
      // have fired — a stalled turn still taught the user whatever frames DID
      // land, so it belongs in their memory trail.
      await ctx.scheduler.runAfter(0, internal.memoryExtract.extractForTurn, {
        turnId: turn._id,
        userId: turn.userId,
      });
      settled.push({
        threadId: turn.threadId,
        turnId: turn._id,
        userId: turn.userId,
        turnIndex: turn.turnIndex,
      });
    }

    return { finalized: settled.length, settled };
  },
});
