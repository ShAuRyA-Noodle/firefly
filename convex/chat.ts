// Chat actions: auth-gated, per-user rate limited, ownership-checked.
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { createThread, listUIMessages, syncStreams } from "@convex-dev/agent";
import { vStreamArgs } from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { components, internal } from "./_generated/api";
import { directorAgent } from "./agent";
import { rateLimiter } from "./rateLimiter";
import { introTextCache } from "./cache";
import { authedAction, authedQuery } from "./lib/functions";
import { groqCostCents } from "./usage";
import type { Id } from "./_generated/dataModel";

export const createNewThread = authedAction({
  args: {},
  handler: async (ctx): Promise<string> => {
    const threadId = await createThread(ctx, components.agent, {
      userId: ctx.userId.toString(),
    });

    await ctx.runMutation(internal.threads.createThreadRecord, {
      agentThreadId: threadId,
      userId: ctx.userId,
    });

    return threadId;
  },
});

/**
 * Fork a new thread from a specific frame. The new thread starts fresh in
 * the agent (clean message history) but carries `parentThreadId` +
 * `anchorFrameId` so the director can pull branch context on the next
 * prompt. Ownership: the anchor frame must belong to the caller.
 */
export const createBranchThread = authedAction({
  args: { fromFrameId: v.id("explanations") },
  handler: async (ctx, { fromFrameId }): Promise<string> => {
    const ownerCheck: { ok: boolean; parentAgentThreadId: string | null } =
      await ctx.runQuery(internal.chat._validateBranchAnchor, {
        fromFrameId,
        userId: ctx.userId,
      });
    if (!ownerCheck.ok || !ownerCheck.parentAgentThreadId) {
      throw new Error("Forbidden");
    }

    const threadId = await createThread(ctx, components.agent, {
      userId: ctx.userId.toString(),
    });

    await ctx.runMutation(internal.threads.createBranchRecord, {
      agentThreadId: threadId,
      userId: ctx.userId,
      parentAgentThreadId: ownerCheck.parentAgentThreadId,
      anchorFrameId: fromFrameId,
    });

    return threadId;
  },
});

async function assertThreadOwner(
  ctx: ActionCtx,
  threadId: string,
  userId: Id<"users">
) {
  const owner: Id<"users"> | null = await ctx.runQuery(
    internal.threads.getOwnerByAgentThread,
    { agentThreadId: threadId }
  );
  if (!owner) throw new Error("Forbidden");
  if (owner !== userId) throw new Error("Forbidden");
}

export const sendMessage = authedAction({
  args: {
    threadId: v.string(),
    prompt: v.string(),
  },
  handler: async (ctx, { threadId, prompt }) => {
    await rateLimiter.limit(ctx, "sendQuestion", { key: ctx.userId, throws: true });
    await rateLimiter.limit(ctx, "dailyQuestions", { key: ctx.userId, throws: true });
    // Deployment-wide ceiling. Every other limit is keyed per user, which
    // bounds nothing when accounts are free and disposable — this is the only
    // guard on TOTAL API spend across all users.
    await rateLimiter.limit(ctx, "globalDailyQuestions", {
      key: "global",
      throws: true,
    });
    await assertThreadOwner(ctx, threadId, ctx.userId);

    // Pre-filter prompt — Llama-Guard via Groq, keyword fallback if model
    // unavailable. Refusal surfaces as a thrown error; the client's
    // humanizeError converts it to a user-facing message.
    const safety: { safe: boolean; categories: string[]; reason?: string } =
      await ctx.runAction(internal.moderation.checkPrompt, { prompt });
    if (!safety.safe) {
      throw new Error(safety.reason ?? "Prompt blocked by safety filter");
    }

    // Open a fresh question turn so the director dispatches against a clean
    // per-question slot budget + settle plan.
    await ctx.runMutation(internal.turns.startTurn, { agentThreadId: threadId });

    const result = await directorAgent.generateText(
      ctx,
      { threadId },
      { prompt }
    );
    return result.text;
  },
});

export const generateIntro = internalAction({
  args: {
    threadId: v.string(),
    userId: v.id("users"),
    prompt: v.string(),
  },
  handler: async (ctx, { threadId, userId, prompt }): Promise<null> => {
    // Cache hit for an identical prompt skips the Groq call + saves ~1s.
    // The cache is scoped to prompt text only — different users asking the
    // same question share the same warm intro (it's generic by design).
    const text: string = await introTextCache.fetch(ctx, { prompt });

    // Usage estimate (best-effort; ActionCache hides whether call hit the
    // upstream). Conservative: log full cost on every call. Over-estimates
    // when the cache hits but never under-states spend.
    try {
      const tokensIn = Math.ceil(prompt.length / 4);
      const tokensOut = Math.ceil(text.length / 4);
      await ctx.runMutation(internal.usage.record, {
        userId,
        kind: "groq.intro",
        tokensIn,
        tokensOut,
        costCents: groqCostCents(tokensIn, tokensOut),
        threadId,
      });
    } catch {
      // swallow — telemetry never blocks
    }

    const explanationId = await ctx.runMutation(internal.explanations.create, {
      threadId,
      userId,
      skill: "intro",
      step: 0,
      config: "{}",
      narration: text,
    });

    await ctx.scheduler.runAfter(0, internal.tts.generateAudio, {
      narration: text,
      explanationId,
    });
    return null;
  },
});

// IOTA: composePrompt (defined below) is invoked from BOTH sendMessageStreaming
// AND sendImageMessage. The function is intentionally left in place — both
// callers pass the same shape of args (memories + branchCtx + dueConcepts).
// If you change composePrompt's signature, audit both call sites in this file.

export const sendImageMessage = authedAction({
  args: {
    threadId: v.string(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, { threadId, storageId }) => {
    // Same gates the typed-prompt path runs. One image = one question, so
    // both per-hour and per-day limiters apply identically.
    await rateLimiter.limit(ctx, "sendQuestion", { key: ctx.userId, throws: true });
    await rateLimiter.limit(ctx, "dailyQuestions", { key: ctx.userId, throws: true });
    // Deployment-wide ceiling. Every other limit is keyed per user, which
    // bounds nothing when accounts are free and disposable — this is the only
    // guard on TOTAL API spend across all users.
    await rateLimiter.limit(ctx, "globalDailyQuestions", {
      key: "global",
      throws: true,
    });
    await assertThreadOwner(ctx, threadId, ctx.userId);

    // Vision OCR + moderation pre-filter happen inside extractQuestion so
    // we don't burn a director invocation on an unreadable image. The
    // action throws on safety-flag rejection; we let that bubble to the
    // client so humanizeError can surface a generic refusal.
    const extraction: { question: string | null; model: string } =
      await ctx.runAction(internal.vision.extractQuestion, {
        storageId,
        userId: ctx.userId,
      });

    if (!extraction.question) {
      throw new Error(
        "Could not read a question from that image — try another photo or type your question.",
      );
    }

    const prompt = extraction.question;

    // Open a fresh question turn. The dispatch path binds every frame to this
    // turn, so an image follow-up on an existing thread gets its own slot
    // budget + settle plan instead of colliding with a prior question.
    await ctx.runMutation(internal.turns.startTurn, {
      agentThreadId: threadId,
    });

    // Title = extracted question, first 80 chars (the threads.setTitleIfUnset
    // mutation truncates internally and is a no-op once a title is set).
    await ctx.runMutation(internal.threads.setTitleIfUnset, {
      agentThreadId: threadId,
      title: prompt,
    });

    await ctx.scheduler.runAfter(0, internal.chat.generateIntro, {
      threadId,
      userId: ctx.userId,
      prompt,
    });

    // Identical augmentation pipeline as sendMessageStreaming — memory
    // breadcrumbs + branch context + due-for-review concepts. Sharing
    // composePrompt avoids drift between the two surfaces.
    const memories: Array<{ summary: string; concepts: string[] }> =
      await ctx.runQuery(internal.memories.recentForUser, {
        userId: ctx.userId,
        limit: 5,
      });
    const branchCtx: { parentSummary: string | null; anchorNarration: string | null } =
      await ctx.runQuery(internal.chat._branchContext, { threadId });
    const dueConcepts: Array<{ concept: string; exposures: number }> =
      await ctx.runQuery(internal.skillProgress.conceptsDueForReview, {
        userId: ctx.userId,
        now: Date.now(),
        limit: 6,
      });

    const augmentedPrompt = composePrompt({
      userPrompt: prompt,
      memories,
      branchCtx,
      dueConcepts: dueConcepts.map((c) => c.concept),
    });

    await directorAgent.streamText(
      ctx,
      { threadId },
      { prompt: augmentedPrompt },
      { saveStreamDeltas: true },
    );

    return { question: prompt, model: extraction.model };
  },
});

export const sendMessageStreaming = authedAction({
  args: {
    threadId: v.string(),
    prompt: v.string(),
  },
  handler: async (ctx, { threadId, prompt }) => {
    await rateLimiter.limit(ctx, "sendQuestion", { key: ctx.userId, throws: true });
    await rateLimiter.limit(ctx, "dailyQuestions", { key: ctx.userId, throws: true });
    // Deployment-wide ceiling. Every other limit is keyed per user, which
    // bounds nothing when accounts are free and disposable — this is the only
    // guard on TOTAL API spend across all users.
    await rateLimiter.limit(ctx, "globalDailyQuestions", {
      key: "global",
      throws: true,
    });
    await assertThreadOwner(ctx, threadId, ctx.userId);

    // Pre-filter — Llama-Guard via Groq with keyword fallback. Throws on
    // unsafe so the streaming pipeline never starts, no Sarvam minutes are
    // consumed, and the user sees a humanized refusal via index.tsx
    // humanizeError. Cost is a single small Groq call (<200 tokens) so the
    // additional latency is negligible vs the multi-second director stream.
    const safety: { safe: boolean; categories: string[]; reason?: string } =
      await ctx.runAction(internal.moderation.checkPrompt, { prompt });
    // Usage estimate: Llama-Guard input ~= prompt chars / 4 (rough chars→tokens
    // conversion), output ~= 10 tokens. Best-effort only; failure non-fatal.
    try {
      const tokensIn = Math.ceil(prompt.length / 4);
      await ctx.runMutation(internal.usage.record, {
        userId: ctx.userId,
        kind: "groq.moderation",
        tokensIn,
        tokensOut: 10,
        costCents: groqCostCents(tokensIn, 10),
        threadId,
      });
    } catch {
      // swallow — telemetry must never block the user path
    }
    if (!safety.safe) {
      throw new Error(safety.reason ?? "Prompt blocked by safety filter");
    }

    // Open a fresh question turn. Every dispatched frame binds to this turn,
    // so a follow-up on an existing thread renders into its own slot budget +
    // settle plan instead of colliding with the previous question on `step`.
    const turn: { turnId: Id<"turns">; turnIndex: number } =
      await ctx.runMutation(internal.turns.startTurn, {
        agentThreadId: threadId,
      });

    // Title = first prompt, first 80 chars. Only set once per thread — the
    // mutation is a no-op if a title already exists.
    await ctx.runMutation(internal.threads.setTitleIfUnset, {
      agentThreadId: threadId,
      title: prompt,
    });

    await ctx.scheduler.runAfter(0, internal.chat.generateIntro, {
      threadId,
      userId: ctx.userId,
      prompt,
    });

    // Prior-context breadcrumbs — the 5 most recent memory summaries for
    // this user. Kept tiny so it doesn't bloat the director's context; the
    // model uses these to avoid re-explaining, reference prior concepts,
    // and deepen the narrative arc instead of restarting from scratch.
    const memories: Array<{ summary: string; concepts: string[] }> =
      await ctx.runQuery(internal.memories.recentForUser, {
        userId: ctx.userId,
        limit: 5,
      });
    // Branch context: if this thread was forked from another, pull the
    // anchor frame's narration so the director knows what "this" refers to.
    const branchCtx: { parentSummary: string | null; anchorNarration: string | null } =
      await ctx.runQuery(internal.chat._branchContext, { threadId });

    // Concepts the user is overdue to review (spaced repetition). The
    // director uses these to seed "Review X" ActionCards in the final UI
    // frame, mixing them in naturally with the next-step suggestions.
    const dueConcepts: Array<{ concept: string; exposures: number }> =
      await ctx.runQuery(internal.skillProgress.conceptsDueForReview, {
        userId: ctx.userId,
        now: Date.now(),
        limit: 6,
      });

    const augmentedPrompt = composePrompt({
      userPrompt: prompt,
      memories,
      branchCtx,
      dueConcepts: dueConcepts.map((c) => c.concept),
    });

    try {
      await directorAgent.streamText(
        ctx,
        { threadId },
        { prompt: augmentedPrompt },
        { saveStreamDeltas: true },
      );
    } finally {
      // The director can finish — or throw (provider error, rate limit) —
      // without ever calling done(). That left expectedFrames unset and the UI
      // stuck on "generating" forever. Seal the turn against the slots it
      // actually dispatched, then run the normal settle so it closes as soon
      // as those frames land. All launches already happened inside streamText,
      // so the dispatched count is final by now.
      await ctx.runMutation(internal.turns.sealTurn, { turnId: turn.turnId });
      const settle = await ctx.runMutation(internal.turns.markDoneIfSettled, {
        turnId: turn.turnId,
        userId: ctx.userId,
      });
      if (settle?.marked) {
        await ctx.scheduler.runAfter(0, internal.memoryExtract.extractForTurn, {
          turnId: turn.turnId,
          userId: ctx.userId,
        });
      }
    }
  },
});

/**
 * Ownership gate for createBranchThread — checks the caller owns the
 * anchor frame and returns the parent thread's agent-id for linkage.
 */
export const _validateBranchAnchor = internalQuery({
  args: { fromFrameId: v.id("explanations"), userId: v.id("users") },
  handler: async (ctx, { fromFrameId, userId }) => {
    const frame = await ctx.db.get(fromFrameId);
    if (!frame || frame.userId !== userId) {
      return { ok: false as const, parentAgentThreadId: null };
    }
    return { ok: true as const, parentAgentThreadId: frame.threadId };
  },
});

/**
 * If the thread was branched from another, resolve the anchor frame's
 * narration + the parent thread's memory summary. Both are optional —
 * returns {null, null} for a fresh root thread.
 */
export const _branchContext = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", threadId))
      .unique();
    if (!thread?.parentThreadId || !thread.anchorFrameId) {
      return { parentSummary: null, anchorNarration: null };
    }
    const anchor = await ctx.db.get(thread.anchorFrameId);
    const parent = await ctx.db.get(thread.parentThreadId);
    // Defense-in-depth: createBranchThread already verifies the caller owns
    // the anchor frame via _validateBranchAnchor before writing the thread
    // row. But if a malformed thread row ever points at a parent owned by
    // a different user, surfacing that user's narration into THIS user's
    // director prompt would be a cross-tenant leak. Hard-fail to empty
    // context instead.
    if (parent && parent.userId !== thread.userId) {
      return { parentSummary: null, anchorNarration: null };
    }
    // Skip tombstoned anchors — they were soft-deleted from the source
    // thread and shouldn't resurrect as branch context.
    const anchorNarration =
      anchor && !anchor.deletedAt ? anchor.narration ?? null : null;
    let parentSummary: string | null = null;
    if (parent?.agentThreadId) {
      const memory = await ctx.db
        .query("user_memories")
        .withIndex("by_thread", (q) => q.eq("threadId", parent.agentThreadId))
        .first();
      parentSummary = memory?.summary ?? null;
    }
    return {
      parentSummary,
      anchorNarration,
    };
  },
});

function composePrompt(args: {
  userPrompt: string;
  memories: Array<{ summary: string; concepts: string[] }>;
  branchCtx: { parentSummary: string | null; anchorNarration: string | null };
  dueConcepts: string[];
}): string {
  const parts: string[] = [];
  if (args.memories.length > 0) {
    parts.push("PRIOR CONTEXT (this user's recent learning — reference, don't repeat):");
    for (const m of args.memories.slice(0, 5)) {
      parts.push(`- ${m.summary}`);
    }
    parts.push("");
  }
  if (args.dueConcepts.length > 0) {
    parts.push(
      "DUE FOR REVIEW (concepts the user has learned but hasn't revisited recently —",
      "if any are even loosely related to this question, weave 1-2 of them in as",
      "ActionCards on the final UI frame, e.g. \"Review: <concept>\"):",
    );
    for (const c of args.dueConcepts.slice(0, 6)) {
      parts.push(`- ${c}`);
    }
    parts.push("");
  }
  if (args.branchCtx.anchorNarration) {
    parts.push("BRANCH CONTEXT (this question is a follow-up to the frame below):");
    parts.push(`> ${args.branchCtx.anchorNarration}`);
    if (args.branchCtx.parentSummary) {
      parts.push(`(from thread about: ${args.branchCtx.parentSummary})`);
    }
    parts.push("");
  }
  // Wrap user content so the director can't be tricked by directive-looking
  // text inside the prompt ("ignore previous instructions"). The director
  // instructions tell the model to treat ONLY content inside the tag as
  // the question, never as commands.
  parts.push("USER QUESTION:");
  parts.push(`<user_question>\n${args.userPrompt}\n</user_question>`);
  return parts.join("\n");
}

export const listThreadMessages = authedQuery({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db
      .query("threads")
      .withIndex("by_agent_thread", (q) =>
        q.eq("agentThreadId", args.threadId)
      )
      .unique();
    if (!owner) throw new Error("Forbidden");
    if (owner.userId !== ctx.userId) throw new Error("Forbidden");

    const paginated = await listUIMessages(ctx, components.agent, args);
    const streams = await syncStreams(ctx, components.agent, args);
    return { ...paginated, streams };
  },
});
