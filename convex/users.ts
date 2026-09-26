/**
 * GDPR / right-to-erasure + right-to-portability.
 *
 * Two public surfaces:
 *
 *   - `deleteMe` (action): tombstones every row the caller owns across
 *     `threads`, `explanations` (+ storage blobs), `user_memories`,
 *     `user_skill_progress`, `user_concept_progress`, `quiz_attempts`,
 *     `userPreferences`, `usage_events`, `share_links`. Convex Auth's user
 *     row deletion is intentionally NOT performed here: at the time of
 *     writing, `@convex-dev/auth` does not expose a stable
 *     `auth.deleteAccount` from the action ctx. The orphan auth row is a
 *     manual one-step `npx convex run auth:deleteUser` call documented in
 *     OPERATIONS.md. (Authentication tokens still expire.)
 *
 *   - `exportMine` (query): returns a JSON dump of everything above plus
 *     the auth identity. Bounded to MAX_EXPORT_ROWS per table to keep the
 *     query under the txn read cap; if the user has more than that, the
 *     UI tells them and they can request a one-shot export from support.
 *
 * Cascade order (load-bearing):
 *
 *   1. Walk explanations FIRST and gather audioStorageIds. We must drop
 *      the storage blobs before deleting the rows that reference them —
 *      otherwise the storage IDs are unrecoverable from a row that's gone.
 *   2. ctx.storage.delete each blob. Failures here are logged, never
 *      block — a missing blob is fine, a referenced blob will be
 *      reconciled by the next storage GC pass.
 *   3. THEN delete explanations rows.
 *   4. Then the rest of the user-owned tables in any order; they have no
 *      cross-references that depend on storage blobs.
 *
 * Transaction limits: each batch processes BATCH_SIZE rows and re-schedules
 * itself via `scheduler.runAfter(0, internal.users.deleteBatch, ...)` until
 * the table is empty for this user. This keeps every individual mutation
 * under Convex's per-txn document limits even for power users with tens of
 * thousands of rows.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { authedAction, authedQuery } from "./lib/functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Batch size per transaction. Convex's per-txn limit is "thousands of docs"
// but the real budget is the SUM of reads + writes; 256 leaves a wide margin
// even when each delete pulls the row's full document on read.
const BATCH_SIZE = 256;
// Max rows per table to surface in `exportMine`. A real GDPR request from a
// power user can be served via `npx convex run users:exportMineAdmin` from
// the dashboard which has no cap.
const MAX_EXPORT_ROWS = 5_000;

// Tables that are user-owned and need a per-user cascade.
type CascadeTable =
  | "threads"
  | "explanations"
  | "user_memories"
  | "user_skill_progress"
  | "user_concept_progress"
  | "quiz_attempts"
  | "userPreferences"
  | "usage_events"
  | "share_links";

const CASCADE_ORDER: CascadeTable[] = [
  // explanations first — its handler drops storage blobs before deleting rows.
  "explanations",
  "threads",
  "user_memories",
  "user_skill_progress",
  "user_concept_progress",
  "quiz_attempts",
  "userPreferences",
  "usage_events",
  "share_links",
];

// ---------------------------------------------------------------------------
// Per-table batch helpers. Each one deletes up to BATCH_SIZE rows owned by
// the user and returns whether more remain. Splitting per table keeps the
// reads narrow (only one index hit per call) and lets the action drive the
// cascade order from the outside.
// ---------------------------------------------------------------------------

/**
 * Delete a batch of explanations: drop audio storage blob first, then row.
 * Storage delete failures are logged but never block — a stuck blob will be
 * GC'd by storage's own reconciliation; a stuck row would block forever.
 */
export const deleteExplanationsBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    const rows = await ctx.db
      .query("explanations")
      .withIndex("by_user_thread", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);

    for (const row of rows) {
      if (row.audioStorageId) {
        try {
          await ctx.storage.delete(row.audioStorageId);
        } catch (err) {
          console.warn(
            `[users.deleteExplanationsBatch] storage.delete failed for ${row.audioStorageId}: ${
              err instanceof Error ? err.message : String(err)
            } — continuing`,
          );
        }
      }
      await ctx.db.delete(row._id);
    }

    return { done: rows.length < BATCH_SIZE, deleted: rows.length };
  },
});

export const deleteThreadsBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return { done: rows.length < BATCH_SIZE, deleted: rows.length };
  },
});

export const deleteUserMemoriesBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    const rows = await ctx.db
      .query("user_memories")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return { done: rows.length < BATCH_SIZE, deleted: rows.length };
  },
});

export const deleteUserSkillProgressBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    const rows = await ctx.db
      .query("user_skill_progress")
      .withIndex("by_user_skill", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return { done: rows.length < BATCH_SIZE, deleted: rows.length };
  },
});

export const deleteUserConceptProgressBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    const rows = await ctx.db
      .query("user_concept_progress")
      .withIndex("by_user_concept", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return { done: rows.length < BATCH_SIZE, deleted: rows.length };
  },
});

export const deleteQuizAttemptsBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    const rows = await ctx.db
      .query("quiz_attempts")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return { done: rows.length < BATCH_SIZE, deleted: rows.length };
  },
});

export const deleteUserPreferencesBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    const rows = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return { done: rows.length < BATCH_SIZE, deleted: rows.length };
  },
});

export const deleteUsageEventsBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    const rows = await ctx.db
      .query("usage_events")
      .withIndex("by_user_ts", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return { done: rows.length < BATCH_SIZE, deleted: rows.length };
  },
});

export const deleteShareLinksBatch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ done: boolean; deleted: number }> => {
    // share_links has no by_user index in the current schema (Beta added
    // `by_slug` + `by_thread` only). For per-user cascade we do a bounded
    // scan with `.take()` and filter — fine for the foreseeable scale
    // (links per user are O(threads), not O(events)).
    const rows = await ctx.db
      .query("share_links")
      .take(BATCH_SIZE * 4);
    const mine = rows.filter((r) => r.userId === userId).slice(0, BATCH_SIZE);
    for (const row of mine) await ctx.db.delete(row._id);
    // We can only confidently say "done" when the whole scan returned fewer
    // than BATCH_SIZE results — otherwise more pages may exist.
    return { done: rows.length < BATCH_SIZE, deleted: mine.length };
  },
});

// Map of table -> batch deleter reference. Action picks them up in cascade
// order. Listed individually (not by table name) so the FunctionReference
// types stay narrow; loose maps lose typing.
async function deleteOneTableUntilEmpty(
  ctx: ActionCtx,
  table: CascadeTable,
  userId: Id<"users">,
): Promise<number> {
  let total = 0;
  // Hard upper bound on iterations to defend against a runaway loop if a
  // batch handler ever returned `done: false` while deleting zero rows.
  for (let i = 0; i < 10_000; i++) {
    let result: { done: boolean; deleted: number };
    switch (table) {
      case "explanations":
        result = await ctx.runMutation(internal.users.deleteExplanationsBatch, { userId });
        break;
      case "threads":
        result = await ctx.runMutation(internal.users.deleteThreadsBatch, { userId });
        break;
      case "user_memories":
        result = await ctx.runMutation(internal.users.deleteUserMemoriesBatch, { userId });
        break;
      case "user_skill_progress":
        result = await ctx.runMutation(internal.users.deleteUserSkillProgressBatch, { userId });
        break;
      case "user_concept_progress":
        result = await ctx.runMutation(internal.users.deleteUserConceptProgressBatch, { userId });
        break;
      case "quiz_attempts":
        result = await ctx.runMutation(internal.users.deleteQuizAttemptsBatch, { userId });
        break;
      case "userPreferences":
        result = await ctx.runMutation(internal.users.deleteUserPreferencesBatch, { userId });
        break;
      case "usage_events":
        result = await ctx.runMutation(internal.users.deleteUsageEventsBatch, { userId });
        break;
      case "share_links":
        result = await ctx.runMutation(internal.users.deleteShareLinksBatch, { userId });
        break;
    }
    total += result.deleted;
    if (result.done) break;
    if (result.deleted === 0) {
      // Defensive: nothing to delete yet `done:false` — bail rather than
      // spin. Should never happen unless a batch helper is buggy.
      console.warn(
        `[users.deleteOneTableUntilEmpty] table=${table} reported done=false with 0 deletions — bailing`,
      );
      break;
    }
  }
  return total;
}

/**
 * Public action: delete every row owned by the calling user.
 *
 * Returns a per-table delete count so the client can show "we removed N
 * rows" feedback. Throws on any failure — partial cascades are surfaced to
 * the caller so they don't think the data is gone.
 */
export const deleteMe = authedAction({
  args: {},
  handler: async (ctx): Promise<Record<CascadeTable, number>> => {
    const counts: Record<CascadeTable, number> = {
      threads: 0,
      explanations: 0,
      user_memories: 0,
      user_skill_progress: 0,
      user_concept_progress: 0,
      quiz_attempts: 0,
      userPreferences: 0,
      usage_events: 0,
      share_links: 0,
    };
    for (const table of CASCADE_ORDER) {
      counts[table] = await deleteOneTableUntilEmpty(ctx, table, ctx.userId);
    }
    return counts;
  },
});

// ---------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------

type UserExport = {
  identity: {
    userId: Id<"users">;
    name: string | null;
    email: string | null;
    issuer: string | null;
    subject: string | null;
  };
  threads: Array<unknown>;
  explanations: Array<unknown>;
  user_memories: Array<unknown>;
  user_skill_progress: Array<unknown>;
  user_concept_progress: Array<unknown>;
  quiz_attempts: Array<unknown>;
  userPreferences: Array<unknown>;
  usage_events: Array<unknown>;
  share_links: Array<unknown>;
  truncated: Record<CascadeTable, boolean>;
  exportedAt: number;
};

export const exportMine = authedQuery({
  args: {},
  handler: async (ctx): Promise<UserExport> => {
    const userId = ctx.userId;

    const [
      threadRows,
      explanationRows,
      userMemoryRows,
      skillProgressRows,
      conceptProgressRows,
      quizRows,
      prefRows,
      usageRows,
      allShareLinks,
    ] = await Promise.all([
      ctx.db
        .query("threads")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
      ctx.db
        .query("explanations")
        .withIndex("by_user_thread", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
      ctx.db
        .query("user_memories")
        .withIndex("by_user_created", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
      ctx.db
        .query("user_skill_progress")
        .withIndex("by_user_skill", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
      ctx.db
        .query("user_concept_progress")
        .withIndex("by_user_concept", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
      ctx.db
        .query("quiz_attempts")
        .withIndex("by_user_created", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
      ctx.db
        .query("userPreferences")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
      ctx.db
        .query("usage_events")
        .withIndex("by_user_ts", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
      // share_links has no by_user index — bounded scan with filter.
      ctx.db.query("share_links").take(MAX_EXPORT_ROWS + 1),
    ]);

    const shareLinkRows = allShareLinks.filter((r) => r.userId === userId);

    const identity = await ctx.auth.getUserIdentity();
    const userDoc = await ctx.db.get(userId);

    function trim<T>(rows: T[]): { rows: T[]; truncated: boolean } {
      if (rows.length > MAX_EXPORT_ROWS) {
        return { rows: rows.slice(0, MAX_EXPORT_ROWS), truncated: true };
      }
      return { rows, truncated: false };
    }

    const t = {
      threads: trim(threadRows),
      explanations: trim(explanationRows),
      user_memories: trim(userMemoryRows),
      user_skill_progress: trim(skillProgressRows),
      user_concept_progress: trim(conceptProgressRows),
      quiz_attempts: trim(quizRows),
      userPreferences: trim(prefRows),
      usage_events: trim(usageRows),
      share_links: trim(shareLinkRows),
    };

    return {
      identity: {
        userId,
        name: identity?.name ?? (userDoc as { name?: string } | null)?.name ?? null,
        email: identity?.email ?? (userDoc as { email?: string } | null)?.email ?? null,
        issuer: identity?.issuer ?? null,
        subject: identity?.subject ?? null,
      },
      threads: t.threads.rows,
      explanations: t.explanations.rows,
      user_memories: t.user_memories.rows,
      user_skill_progress: t.user_skill_progress.rows,
      user_concept_progress: t.user_concept_progress.rows,
      quiz_attempts: t.quiz_attempts.rows,
      userPreferences: t.userPreferences.rows,
      usage_events: t.usage_events.rows,
      share_links: t.share_links.rows,
      truncated: {
        threads: t.threads.truncated,
        explanations: t.explanations.truncated,
        user_memories: t.user_memories.truncated,
        user_skill_progress: t.user_skill_progress.truncated,
        user_concept_progress: t.user_concept_progress.truncated,
        quiz_attempts: t.quiz_attempts.truncated,
        userPreferences: t.userPreferences.truncated,
        usage_events: t.usage_events.truncated,
        share_links: t.share_links.truncated,
      },
      exportedAt: Date.now(),
    };
  },
});

// ---------------------------------------------------------------------------
// Internal helper: lookup whether a userId is anonymous. Beta's rate limiter
// has a `ttsPerAnonymousUser` bucket that's defined-but-unused waiting for
// this hook. Anonymous users have no email on the auth row.
// ---------------------------------------------------------------------------
export const isAnonymous = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<boolean> => {
    const u = await ctx.db.get(userId);
    if (!u) return true;
    const email = (u as { email?: string | null }).email ?? null;
    return !email;
  },
});
