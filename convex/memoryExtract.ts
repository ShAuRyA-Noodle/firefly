/**
 * Memory extractor — runs exactly once per completed thread (guarded by the
 * unique index on user_memories.by_thread).
 *
 * Reads the intro + all frame narrations, asks Groq for a one-line summary
 * and a short concept list, writes them to user_memories, and bumps each
 * concept's exposure counter. The summary is later injected into the
 * director's prompt on follow-up questions as prior context.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { generateText } from "ai";
import { internal } from "./_generated/api";
import { utilityTextModel } from "./lib/models";
import { logged, log } from "./lib/log";
import { z } from "zod";

const EXTRACT_PROMPT = `You are a memory indexer for a visual learning app.
Given the narrations of an explanation thread, output STRICT JSON on ONE line:
  {"summary":"<one sentence, <120 chars, what the user learned>","concepts":["<concept 1>","<concept 2>"]}

Rules:
- summary is past-tense, written to the user ("you learned that...").
- concepts are short noun phrases, lowercase, 1-4 words each, 2-5 total.
- no markdown, no commentary, no trailing text — JSON only.`;

const extractSchema = z.object({
  summary: z.string().min(1).max(200),
  concepts: z.array(z.string().min(1).max(40)).min(1).max(5),
});

/**
 * Canonicalize a concept string at insert time so the four storage
 * locations (user_memories.concepts, user_concept_progress.concept,
 * quiz_attempts.concept, plus any future readers) agree on identity.
 * Lowercase + trim + collapse internal whitespace.
 */
function normalizeConcept(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

export const extractForThread = internalAction({
  args: {
    threadId: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, { threadId, userId }): Promise<null> => {
    return await logged(
      "memory-extract",
      async () => {
        const frames = await ctx.runQuery(
          internal.memoryExtract._framesForThread,
          { threadId },
        );
        const narrations = frames
          .map((f: { narration?: string }) => f.narration?.trim())
          .filter((s: string | undefined): s is string =>
            Boolean(s && s.length > 0),
          );
        if (narrations.length === 0) {
          log.info("memory-extract-skip-empty", { threadId });
          return null;
        }

        const transcript = narrations.join("\n---\n");
        const { text } = await generateText({
          model: utilityTextModel(),
          system: EXTRACT_PROMPT,
          prompt: transcript,
        });

        const parsed = safeParseJson(text);
        const validated = extractSchema.safeParse(parsed);
        if (!validated.success) {
          log.warn("memory-extract-invalid", {
            threadId,
            issues: validated.error.issues.slice(0, 3),
            rawPreview: text.slice(0, 200),
          });
          return null;
        }

        // Normalize once at the upstream insert site so all four storage
        // locations agree on canonical concept identity. Filter empties
        // (e.g. " " → "") and dedupe in case the model emitted variants
        // that collide after normalization.
        const normalized = Array.from(
          new Set(
            validated.data.concepts
              .map((c) => normalizeConcept(c))
              .filter((c) => c.length > 0),
          ),
        );
        if (normalized.length === 0) {
          log.warn("memory-extract-empty-concepts", { threadId });
          return null;
        }

        await ctx.runMutation(internal.memories.insertMemory, {
          userId,
          threadId,
          summary: validated.data.summary,
          concepts: normalized,
        });

        for (const concept of normalized) {
          await ctx.runMutation(internal.skillProgress.bumpConcept, {
            userId,
            concept,
          });
        }

        log.info("memory-extract-done", {
          threadId,
          concepts: normalized.length,
        });
        return null;
      },
      { threadId, userId },
    );
  },
});

function safeParseJson(text: string): unknown {
  const trimmed = text.trim();
  // Models sometimes wrap JSON in ```json fences despite the instruction.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    // Last-ditch: find the first { ... } span.
    const match = unfenced.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

import { internalQuery } from "./_generated/server";

function isNarratedFrame(skill: string): boolean {
  // Sentinels + generic intros carry no question-specific content worth
  // summarizing.
  return skill !== "_done" && skill !== "intro" && skill !== "_failed";
}

export const _framesForThread = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const rows = await ctx.db
      .query("explanations")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return rows.filter(
      (r) => isNarratedFrame(r.skill) && !r.deletedAt && r.narration,
    );
  },
});

export const _framesForTurn = internalQuery({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => {
    const rows = await ctx.db
      .query("explanations")
      .withIndex("by_turn", (q) => q.eq("turnId", turnId))
      .collect();
    return rows.filter(
      (r) => isNarratedFrame(r.skill) && !r.deletedAt && r.narration,
    );
  },
});

/**
 * Per-question memory extraction. Runs once per settled turn (guarded by the
 * by_turn dedup in insertMemory). Summarizes that ONE question's narrations,
 * so a thread with many follow-ups builds a memory breadcrumb per question
 * instead of only ever remembering the first.
 */
export const extractForTurn = internalAction({
  args: { turnId: v.id("turns"), userId: v.id("users") },
  handler: async (ctx, { turnId, userId }): Promise<null> => {
    return await logged(
      "memory-extract-turn",
      async () => {
        const frames = await ctx.runQuery(
          internal.memoryExtract._framesForTurn,
          { turnId },
        );
        const narrations = frames
          .map((f: { narration?: string }) => f.narration?.trim())
          .filter((s: string | undefined): s is string =>
            Boolean(s && s.length > 0),
          );
        if (narrations.length === 0) {
          log.info("memory-extract-turn-skip-empty", { turnId });
          return null;
        }
        const threadId = frames[0].threadId;

        const transcript = narrations.join("\n---\n");
        const { text } = await generateText({
          model: utilityTextModel(),
          system: EXTRACT_PROMPT,
          prompt: transcript,
        });

        const parsed = safeParseJson(text);
        const validated = extractSchema.safeParse(parsed);
        if (!validated.success) {
          log.warn("memory-extract-turn-invalid", {
            turnId,
            issues: validated.error.issues.slice(0, 3),
            rawPreview: text.slice(0, 200),
          });
          return null;
        }

        const normalized = Array.from(
          new Set(
            validated.data.concepts
              .map((c) => normalizeConcept(c))
              .filter((c) => c.length > 0),
          ),
        );
        if (normalized.length === 0) {
          log.warn("memory-extract-turn-empty-concepts", { turnId });
          return null;
        }

        await ctx.runMutation(internal.memories.insertMemory, {
          userId,
          threadId,
          turnId,
          summary: validated.data.summary,
          concepts: normalized,
        });

        for (const concept of normalized) {
          await ctx.runMutation(internal.skillProgress.bumpConcept, {
            userId,
            concept,
          });
        }

        log.info("memory-extract-turn-done", {
          turnId,
          concepts: normalized.length,
        });
        return null;
      },
      { turnId, userId },
    );
  },
});
