/**
 * Per-user skill and concept progression.
 *
 * Two counters:
 *   - skill exposures — how many frames of each visual skill (manim, diagram,
 *     ui, particles) the user has seen. Drives "you love particles, here's
 *     another" recommendations and the skill-tree completeness bar.
 *   - concept exposures — how many times a concept (extracted by the memory
 *     extractor) has been taught to this user. Powers spaced repetition in
 *     Phase 3 (next review time) and the concept graph on the profile page.
 *
 * Both are upserts, so they stay O(1) per frame no matter how much history
 * the user accumulates.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedQuery } from "./lib/functions";

export const bumpSkill = internalMutation({
  args: {
    userId: v.id("users"),
    skill: v.string(),
  },
  handler: async (ctx, { userId, skill }) => {
    // Ignore the internal sentinels — they aren't real skills.
    if (skill === "_done" || skill === "intro") return null;
    const existing = await ctx.db
      .query("user_skill_progress")
      .withIndex("by_user_skill", (q) =>
        q.eq("userId", userId).eq("skill", skill),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        exposures: existing.exposures + 1,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.insert("user_skill_progress", {
        userId,
        skill,
        exposures: 1,
        lastSeenAt: now,
      });
    }
    return null;
  },
});

export const bumpConcept = internalMutation({
  args: {
    userId: v.id("users"),
    concept: v.string(),
  },
  handler: async (ctx, { userId, concept }) => {
    const normalized = concept.trim().toLowerCase();
    if (!normalized) return null;
    const existing = await ctx.db
      .query("user_concept_progress")
      .withIndex("by_user_concept", (q) =>
        q.eq("userId", userId).eq("concept", normalized),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        exposures: existing.exposures + 1,
        lastSeenAt: now,
        // Simple spaced-repetition curve: doubling intervals (SM-2 lite).
        // First exposure → 1 day, second → 3 days, third → 7 days, etc.
        nextReviewAt: now + reviewIntervalMs(existing.exposures + 1),
      });
    } else {
      await ctx.db.insert("user_concept_progress", {
        userId,
        concept: normalized,
        exposures: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        nextReviewAt: now + reviewIntervalMs(1),
      });
    }
    return null;
  },
});

function reviewIntervalMs(exposures: number): number {
  // Anki-lite: [1, 3, 7, 16, 35, 80] days for exposures 1..6+
  const days = [1, 3, 7, 16, 35, 80];
  const d = days[Math.min(exposures - 1, days.length - 1)];
  return d * 24 * 60 * 60 * 1000;
}

export const getSkillProgressForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("user_skill_progress")
      .withIndex("by_user_skill", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((r) => ({
      skill: r.skill,
      exposures: r.exposures,
      lastSeenAt: r.lastSeenAt,
    }));
  },
});

export const myProgress = authedQuery({
  args: {},
  handler: async (ctx) => {
    const skills = await ctx.db
      .query("user_skill_progress")
      .withIndex("by_user_skill", (q) => q.eq("userId", ctx.userId))
      .collect();
    const concepts = await ctx.db
      .query("user_concept_progress")
      .withIndex("by_user_concept", (q) => q.eq("userId", ctx.userId))
      .collect();
    concepts.sort((a, b) => b.exposures - a.exposures);
    return {
      skills: skills.map((s) => ({
        skill: s.skill,
        exposures: s.exposures,
        lastSeenAt: s.lastSeenAt,
      })),
      concepts: concepts.slice(0, 64).map((c) => ({
        concept: c.concept,
        exposures: c.exposures,
        lastSeenAt: c.lastSeenAt,
        nextReviewAt: c.nextReviewAt ?? null,
      })),
    };
  },
});

/** Concepts due for spaced-repetition review at a given time. Used by
 *  the ActionCard-suggestion path to surface "Review X" prompts.
 *
 *  Uses a true range scan on the [userId, nextReviewAt] index so the DB
 *  returns only rows that are actually due. The previous take-then-filter
 *  approach took the first N rows for the user (any nextReviewAt) and
 *  threw away the ones that weren't due — meaning a heavy user with a
 *  long tail of future-dated concepts could miss currently-due ones
 *  entirely if they sorted later. */
export const conceptsDueForReview = internalQuery({
  args: {
    userId: v.id("users"),
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { userId, now, limit }) => {
    return await ctx.db
      .query("user_concept_progress")
      .withIndex("by_user_nextReview", (q) =>
        q.eq("userId", userId).lte("nextReviewAt", now),
      )
      .take(Math.min(limit, 32));
  },
});
