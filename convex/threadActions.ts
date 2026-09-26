/**
 * User-facing thread management mutations: rename, archive, restore, delete.
 *
 * Lives in its own file (rather than threads.ts) because Beta owns threads.ts
 * and these are Theta-owned product features. Ownership checks are explicit
 * — the authedMutation wrapper gives us `ctx.userId`, and every mutation
 * loads the thread row by `agentThreadId` and verifies ownership before
 * touching any data.
 *
 * Delete is the heavy one. A thread fans out into:
 *   - explanations rows (1..N per thread, each potentially with an
 *     audioStorageId blob)
 *   - user_memories rows (one per thread when memory extraction succeeded)
 *   - share_links rows (zero or more, persisted for audit)
 *   - the threads row itself
 *
 * Convex mutations have a per-transaction cap on document reads/writes, so
 * deleting a thread with hundreds of frames must batch. We follow the pattern
 * documented in convex/_generated/ai/guidelines.md:
 *   1. take(BATCH) explanations,
 *   2. delete each (storage blob first, then row),
 *   3. if the batch was full, ctx.scheduler.runAfter(0, ..., self) to
 *      continue,
 *   4. once explanations are drained, sweep memories and the thread row.
 *
 * The internal helper `_deleteThreadStep` is what gets rescheduled. The
 * public `deleteThread` mutation does the ownership check + kicks off the
 * first batch synchronously so the user gets immediate feedback.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { authedMutation, authedQuery } from "./lib/functions";
import { internal } from "./_generated/api";

// Batch size for the recursive delete walker. Tuned conservatively: each
// row deletion touches up to one storage blob + the row itself, plus a
// share_link row when sweeping. 32 keeps us well under the 16k transaction
// limit even on threads with very dense audio.
const DELETE_BATCH = 32;

/**
 * Paginated list of the caller's threads, newest first. Theta-owned counterpart
 * to threads.listMine (Beta) that uses cursor pagination for "load more" UX.
 *
 * Returns `{page, isDone, continueCursor}` shaped per the Convex pagination
 * contract. Archived threads are filtered out so the default UI surface stays
 * clean — a future "archive" view can read the same query with a flag.
 *
 * Cursor semantics: cursor is opaque, encodes (index, _creationTime) tuple
 * managed by Convex. Filtering out archived rows post-paginate would break
 * page-size invariants (a page might come back smaller than numItems if the
 * archived ratio is high). We filter inside the page on a per-batch basis
 * and accept that some pages may be partial — the client just calls "load
 * more" again until isDone.
 *
 * Each row includes parent thread metadata (for "branch of X" labels) and a
 * boolean indicating whether a public share exists, so the row UI can render
 * the share button state without N+1 queries from the client.
 */
export const listMinePaged = authedQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, { paginationOpts, includeArchived }) => {
    const result = await ctx.db
      .query("threads")
      .withIndex("by_user_created", (q) => q.eq("userId", ctx.userId))
      .order("desc")
      .paginate(paginationOpts);

    const filtered = includeArchived
      ? result.page
      : result.page.filter((r) => !r.archivedAt);

    const enriched = await Promise.all(
      filtered.map(async (r) => {
        let parentAgentThreadId: string | null = null;
        if (r.parentThreadId) {
          const p = await ctx.db.get(r.parentThreadId);
          parentAgentThreadId = p?.agentThreadId ?? null;
        }
        const shares = await ctx.db
          .query("share_links")
          .withIndex("by_thread", (q) => q.eq("threadId", r.agentThreadId))
          .collect();
        const activeShare = shares.find((s) => !s.revoked);
        return {
          agentThreadId: r.agentThreadId,
          createdAt: r.createdAt,
          title: r.title ?? null,
          doneMarkedAt: r.doneMarkedAt ?? null,
          parentAgentThreadId,
          anchorFrameId: r.anchorFrameId ?? null,
          archivedAt: r.archivedAt ?? null,
          shareSlug: activeShare?.slug ?? null,
        };
      }),
    );

    return {
      page: enriched,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const renameThread = authedMutation({
  args: { agentThreadId: v.string(), title: v.string() },
  handler: async (ctx, { agentThreadId, title }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) throw new Error("Not found");
    if (row.userId !== ctx.userId) throw new Error("Forbidden");

    // Same trim+collapse rules as the auto-titler (threads.setTitleIfUnset)
    // — keeps the list view consistent regardless of who set the title.
    const trimmed = title.trim().replace(/\s+/g, " ").slice(0, 80);
    if (trimmed.length === 0) throw new Error("Title cannot be empty");

    await ctx.db.patch(row._id, { title: trimmed });
    return null;
  },
});

export const archiveThread = authedMutation({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) throw new Error("Not found");
    if (row.userId !== ctx.userId) throw new Error("Forbidden");
    await ctx.db.patch(row._id, { archivedAt: Date.now() });
    return null;
  },
});

export const unarchiveThread = authedMutation({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) throw new Error("Not found");
    if (row.userId !== ctx.userId) throw new Error("Forbidden");
    await ctx.db.patch(row._id, { archivedAt: undefined });
    return null;
  },
});

export const deleteThread = authedMutation({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!row) throw new Error("Not found");
    if (row.userId !== ctx.userId) throw new Error("Forbidden");

    // Mark the thread "being deleted" by archiving it so the UI hides it
    // immediately, even before the async sweep finishes. Without this the
    // user sees the thread linger until all explanations drain.
    await ctx.db.patch(row._id, { archivedAt: Date.now() });

    // Kick off the recursive delete walker. We do this via scheduler so the
    // mutation returns fast — the user clicks delete and the thread vanishes
    // from their list immediately, while cleanup runs in the background.
    await ctx.scheduler.runAfter(0, internal.threadActions._deleteThreadStep, {
      agentThreadId,
    });
    return null;
  },
});

/**
 * Recursive sweeper: deletes one batch of explanations per call, including
 * their audio blobs, and reschedules itself until the thread's explanations
 * are gone. Then sweeps memories + share_links + the thread row.
 *
 * Internal — never call from a client. Idempotent: if the thread row is
 * already gone, exits cleanly. Safe to re-run if the scheduler retries.
 */
export const _deleteThreadStep = internalMutation({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    // Drain explanations in batches. The by_thread index lets us walk
    // without a full table scan.
    const explanations = await ctx.db
      .query("explanations")
      .withIndex("by_thread", (q) => q.eq("threadId", agentThreadId))
      .take(DELETE_BATCH);

    for (const exp of explanations) {
      // Best-effort blob delete — if storage is already gone (manual cleanup,
      // earlier failed sweep), we still want to drop the row. The warn lets
      // us notice if blobs are leaking systematically.
      if (exp.audioStorageId) {
        try {
          await ctx.storage.delete(exp.audioStorageId);
        } catch (err) {
          console.warn(
            `[deleteThread] storage.delete failed for ${exp.audioStorageId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      await ctx.db.delete(exp._id);
    }

    // More explanations to come — reschedule and bail. Using runAfter(0)
    // rather than a tight loop so each batch runs in its own transaction,
    // avoiding the per-mutation document-write cap on huge threads.
    if (explanations.length === DELETE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.threadActions._deleteThreadStep, {
        agentThreadId,
      });
      return null;
    }

    // Explanations drained — sweep memories. Cap at DELETE_BATCH per call,
    // reschedule if there are more (rare but possible if memory extraction
    // ran multiple times for the same thread under a bug).
    const memories = await ctx.db
      .query("user_memories")
      .withIndex("by_thread", (q) => q.eq("threadId", agentThreadId))
      .take(DELETE_BATCH);
    for (const m of memories) {
      await ctx.db.delete(m._id);
    }
    if (memories.length === DELETE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.threadActions._deleteThreadStep, {
        agentThreadId,
      });
      return null;
    }

    // Sweep share_links — these reference the thread by string id, not row
    // id, so they don't go stale via cascade. We drop them too so a deleted
    // thread can't be resurrected via an old share URL (getSharedThread
    // joins through threadId on read, but better to remove the link row).
    const shares = await ctx.db
      .query("share_links")
      .withIndex("by_thread", (q) => q.eq("threadId", agentThreadId))
      .take(DELETE_BATCH);
    for (const s of shares) {
      await ctx.db.delete(s._id);
    }
    if (shares.length === DELETE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.threadActions._deleteThreadStep, {
        agentThreadId,
      });
      return null;
    }

    // Finally, the thread row itself. Idempotent — if a concurrent run
    // already removed it, ctx.db.delete throws; we swallow that case.
    const row = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (row) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
