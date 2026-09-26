/**
 * Quiz answer recording.
 *
 * The "quiz" frame is a `ui` skill payload that includes a Quiz component
 * (handled in UIRenderer). When the user answers, the client calls
 * recordAnswer with the explanationId, the question index, and the
 * selection. The server resolves the correct answer and concept tag from
 * the persisted explanation config — never trusting the client — then
 * inserts an attempt row, and bumps concept progress on a correct answer.
 *
 * Why server-side resolution: a malicious client could otherwise script
 * `correctAnswer === selectedAnswer` to farm free mastery on the concept
 * counter. By reading from the immutable explanation row, the server is
 * the only authority on what the right answer is.
 */

import { v } from "convex/values";
import { authedMutation, authedQuery } from "./lib/functions";
import { internal } from "./_generated/api";

// Recursive walker: returns the Nth (0-indexed) Quiz node anywhere in the
// json-render tree, in document order. Children may be `JsonNode[] | string`
// (string-children are leaves and never contain quiz nodes). The accumulator
// is threaded through `count` so the caller can inspect total quiz nodes.
type JsonNode = {
  component?: string;
  props?: Record<string, unknown>;
  children?: JsonNode[] | string;
};

function findQuizNode(
  node: unknown,
  index: number,
): { node: JsonNode; count: number } | null {
  let count = 0;
  function walk(n: unknown): JsonNode | null {
    if (n == null || typeof n !== "object") return null;
    const cur = n as JsonNode;
    const name = typeof cur.component === "string" ? cur.component : "";
    if (name === "QuizMCQ" || name === "QuizFill") {
      if (count === index) return cur;
      count += 1;
    }
    const children = cur.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = walk(child);
        if (found) return found;
      }
    }
    // string children are leaves; skip.
    return null;
  }
  const found = walk(node);
  return found ? { node: found, count } : null;
}

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

export const recordAnswer = authedMutation({
  args: {
    explanationId: v.id("explanations"),
    questionIndex: v.number(),
    selectedAnswer: v.string(),
    // Client may pass a concept tag for analytics/debug, but the server
    // only honors it if it matches the resolved quiz node's concept prop.
    // Otherwise the client value is discarded.
    concept: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { explanationId, questionIndex, selectedAnswer, concept: clientConcept },
  ) => {
    const exp = await ctx.db.get(explanationId);
    if (!exp) throw new Error("Not found");
    if (exp.userId !== ctx.userId) throw new Error("Forbidden");

    let parsed: unknown;
    try {
      parsed = JSON.parse(exp.config);
    } catch {
      throw new Error("Explanation config is not valid JSON");
    }

    const found = findQuizNode(parsed, questionIndex);
    if (!found) {
      throw new Error(`No quiz at index ${questionIndex}`);
    }

    const props = (found.node.props ?? {}) as Record<string, unknown>;
    const rawCorrect = props["correctAnswer"];
    if (typeof rawCorrect !== "string") {
      throw new Error(
        `Quiz at index ${questionIndex} has no correctAnswer in config`,
      );
    }
    const correctAnswer = rawCorrect;

    // Server-side concept: only the value embedded in the persisted config.
    // The client's `concept` arg is accepted ONLY when it matches the
    // server-resolved tag (defensive: prevents "concept laundering" where a
    // user maps a wrong answer onto a different concept's mastery).
    const rawConcept = props["concept"];
    const serverConcept = typeof rawConcept === "string" ? rawConcept : undefined;
    const acceptedConcept =
      serverConcept !== undefined &&
      (clientConcept === undefined ||
        normalize(clientConcept) === normalize(serverConcept))
        ? serverConcept
        : undefined;

    const correct = normalize(selectedAnswer) === normalize(correctAnswer);

    // Store normalized concept for cross-table consistency with
    // user_concept_progress (which lowercases on insert). Raw selected /
    // correct values stay as-is for audit visibility on the profile page.
    const storedConcept = acceptedConcept
      ? normalize(acceptedConcept)
      : undefined;

    await ctx.db.insert("quiz_attempts", {
      userId: ctx.userId,
      threadId: exp.threadId,
      explanationId,
      questionIndex,
      correct,
      selectedAnswer,
      correctAnswer,
      concept: storedConcept,
      createdAt: Date.now(),
    });

    // Correct answer = real evidence of mastery; bump the concept counter
    // through the same path the memory extractor uses, which feeds spaced
    // repetition. Wrong answers do NOT decrement — they just don't help.
    // Inline runMutation so the bump commits in the same transaction; a
    // crash between insert and scheduler.runAfter would otherwise lose the
    // bump while leaving the attempt recorded.
    if (correct && acceptedConcept) {
      await ctx.runMutation(internal.skillProgress.bumpConcept, {
        userId: ctx.userId,
        concept: acceptedConcept,
      });
    }
    return { correct, correctAnswer };
  },
});

/**
 * Recent quiz attempts for the caller — feeds the profile page's score line
 * and lets the director know what's been correctly answered (avoids
 * re-quizzing material the user has already nailed in this session).
 */
export const recentAttempts = authedQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = Math.min(limit ?? 50, 200);
    return await ctx.db
      .query("quiz_attempts")
      .withIndex("by_user_created", (q) => q.eq("userId", ctx.userId))
      .order("desc")
      .take(cap);
  },
});

export const myQuizScore = authedQuery({
  args: { sinceMs: v.optional(v.number()) },
  handler: async (ctx, { sinceMs }) => {
    const since = sinceMs ?? Date.now() - 1000 * 60 * 60 * 24 * 30;
    const rows = await ctx.db
      .query("quiz_attempts")
      .withIndex("by_user_created", (q) => q.eq("userId", ctx.userId))
      .order("desc")
      .take(500);
    const recent = rows.filter((r) => r.createdAt >= since);
    const total = recent.length;
    const correct = recent.filter((r) => r.correct).length;
    return { total, correct, accuracy: total > 0 ? correct / total : null };
  },
});
