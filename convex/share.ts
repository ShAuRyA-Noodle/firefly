/**
 * Public read-only thread sharing.
 *
 * Model: a `share_links` row maps a random slug → (threadId, userId). The
 * slug is the URL token. `revoked: true` is a tombstone — keeps the row
 * around so we know "this slug used to point to this thread" but stops
 * serving the content. Hard-deleting would let an attacker re-mint the same
 * slug for someone else if our RNG ever collides.
 *
 * Race conditions to think about:
 *   - createShareLink under double-click: two concurrent calls both see
 *     "no active link" and insert two rows. We accept this — both slugs
 *     resolve to the same thread, and idempotency on the most-recent active
 *     link is checked at read time. The duplicate is harmless.
 *   - revokeShareLink during an in-flight getSharedThread: Convex queries
 *     are transactional, so the read either sees the pre-revoke state or
 *     the post-revoke state, never a half-state. Worst case: a user clicks
 *     revoke and one already-loaded tab keeps showing the content for the
 *     duration of its current React render before the next reactive update
 *     flips it to "revoked". This is the expected UX.
 *
 * Auth surface:
 *   - createShareLink, revokeShareLink, getMyShareLinkForThread: authed
 *   - getSharedThread: PUBLIC — no auth check. Anyone with the slug can read.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { authedQuery, authedMutation } from "./lib/functions";

const SLUG_LEN = 12;
const SLUG_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Cryptographically random slug. crypto.getRandomValues is available in the
 * default Convex runtime. We avoid Math.random because slug guessability
 * matters for an unauthenticated read endpoint — predictable slugs would
 * let a scraper enumerate every shared thread.
 */
function generateSlug(): string {
  const buf = new Uint32Array(SLUG_LEN);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < SLUG_LEN; i++) {
    s += SLUG_ALPHABET[buf[i] % SLUG_ALPHABET.length];
  }
  return s;
}

export const createShareLink = authedMutation({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!thread) throw new Error("Not found");
    if (thread.userId !== ctx.userId) throw new Error("Forbidden");

    // Idempotent: if a non-revoked link already exists for this thread,
    // return its slug. Otherwise users would accumulate stale shareable
    // URLs each time they click "share". The by_thread index keeps this O(1)
    // even for users with thousands of threads.
    const existing = await ctx.db
      .query("share_links")
      .withIndex("by_thread", (q) => q.eq("threadId", agentThreadId))
      .collect();
    const active = existing.find((s) => !s.revoked);
    if (active) return active.slug;

    // Collision check — astronomically unlikely with 62^12 keyspace, but
    // cheap to guard against. If we hit one, regenerate.
    let slug = generateSlug();
    for (let attempt = 0; attempt < 5; attempt++) {
      const collision = await ctx.db
        .query("share_links")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (!collision) break;
      slug = generateSlug();
    }

    await ctx.db.insert("share_links", {
      threadId: agentThreadId,
      userId: ctx.userId,
      slug,
      createdAt: Date.now(),
    });
    return slug;
  },
});

export const revokeShareLink = authedMutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const row = await ctx.db
      .query("share_links")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!row) throw new Error("Not found");
    if (row.userId !== ctx.userId) throw new Error("Forbidden");
    await ctx.db.patch(row._id, { revoked: true });
    return null;
  },
});

/**
 * Owner-side read of the share state for a given thread. Lets the me.tsx
 * UI render "share copied" / "revoke" buttons accurately without exposing
 * the slug to anyone else. Returns null when the thread has never been
 * shared, or when the most recent share is revoked.
 */
export const getMyShareLinkForThread = authedQuery({
  args: { agentThreadId: v.string() },
  handler: async (ctx, { agentThreadId }) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
      .unique();
    if (!thread) return null;
    if (thread.userId !== ctx.userId) throw new Error("Forbidden");

    const rows = await ctx.db
      .query("share_links")
      .withIndex("by_thread", (q) => q.eq("threadId", agentThreadId))
      .collect();
    const active = rows.find((r) => !r.revoked);
    return active
      ? { slug: active.slug, createdAt: active.createdAt }
      : null;
  },
});

/**
 * PUBLIC read endpoint. Used by the unauthenticated /share/$threadId route.
 *
 * Resolves a slug → thread + frames. Filters out _done sentinels, intro
 * narrations (those are session-warmup chatter, not content), and
 * tombstoned rows. Resolves audio blob URLs via ctx.storage.getUrl since
 * the unauthenticated viewer can't sign URLs themselves.
 *
 * Returned shape deliberately omits userId — we don't want random viewers
 * inferring the owner's identity from a public share. Title comes from the
 * thread row.
 *
 * RATE LIMIT TODO: this endpoint is public and reads up to MAX_FRAMES rows
 * + their storage URLs per call. A scraper looping over leaked slugs could
 * generate measurable load. Gamma owns the rate limiter — leaving a hook
 * here for follow-up to wire `rateLimiter.limit(ctx, "publicShareReads",
 * { key: slug })` once Gamma adds that bucket. Until then, slug
 * unguessability + Convex's per-deployment query cost ceiling are the only
 * defense.
 */
export const getSharedThread = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const link = await ctx.db
      .query("share_links")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!link || link.revoked) return null;

    const thread = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", link.threadId))
      .unique();
    if (!thread) return null;

    const explanations = await ctx.db
      .query("explanations")
      .withIndex("by_thread", (q) => q.eq("threadId", link.threadId))
      .collect();

    // Same filter set the owner-side reader uses (explanations.getByThread):
    // sentinels, intros, and tombstones never reach the viewer.
    const live = explanations.filter(
      (e) =>
        e.skill !== "_done" &&
        e.skill !== "intro" &&
        e.skill !== "_failed" &&
        !e.deletedAt,
    );

    const frames = await Promise.all(
      live.map(async (exp) => {
        const audioUrl = exp.audioStorageId
          ? await ctx.storage.getUrl(exp.audioStorageId)
          : null;
        // Explicit field projection so we never accidentally leak userId,
        // messageId, or any future auth-sensitive column added to
        // explanations rows.
        return {
          _id: exp._id,
          skill: exp.skill,
          config: exp.config,
          narration: exp.narration ?? null,
          audioUrl: audioUrl ?? exp.audioUrl ?? null,
          audioTimings: exp.audioTimings ?? null,
          step: exp.step ?? null,
          createdAt: exp.createdAt,
        };
      }),
    );

    // Sort by step ascending then creationTime — same ordering the live
    // viewer uses, so a shared thread reads identically to the owner's
    // view.
    frames.sort((a, b) => {
      const sa = a.step ?? Infinity;
      const sb = b.step ?? Infinity;
      if (sa !== sb) return sa - sb;
      return a.createdAt - b.createdAt;
    });

    return {
      title: thread.title ?? null,
      frames,
      createdAt: thread.createdAt,
    };
  },
});
