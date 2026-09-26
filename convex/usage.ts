/**
 * Per-call cost + token telemetry.
 *
 * `internal.usage.record` is the firehose: every LLM/TTS call site logs one
 * row. The aggregator query `myUsage` rolls the last 30 days up by kind for
 * the profile/usage screen.
 *
 * Cost rates are hardcoded constants. They drift with provider pricing — if
 * Groq or Sarvam change their public prices, bump these and the historical
 * rows stay stamped with the rate that was current at insertion time
 * (because we store costCents per row, not just usage).
 *
 * WIRING NOTE (other agents): import `internal.usage.record` and call it
 * after each LLM/TTS call site:
 *   - convex/agent.ts: groq director + groq subagent (kinds: groq.director,
 *     groq.subagent)
 *   - convex/chat.ts: groq intro + groq memory (kinds: groq.intro,
 *     groq.memory)
 *   - convex/tts.ts / ttsProviders.ts: sarvam tts + groq whisper
 *     (kinds: sarvam.tts, groq.whisper)
 *   - convex/moderation.ts: groq moderation pre-filter (kind: groq.moderation)
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedQuery } from "./lib/functions";

// ---------------------------------------------------------------------------
// Pricing constants (USD, public list rates as of 2026-05).
// All in dollars per million units; converted to cents in compute helpers.
// ---------------------------------------------------------------------------

/** Groq input tokens, gpt-oss-120b — $0.05 per 1M tokens. */
export const GROQ_TOKENS_IN_PER_M = 0.05;
/** Groq output tokens, gpt-oss-120b — $0.20 per 1M tokens. */
export const GROQ_TOKENS_OUT_PER_M = 0.20;
/** Sarvam TTS — $0.40 per 1M characters. */
export const SARVAM_CHARS_PER_M = 0.40;

/**
 * Pure helper: compute the cents cost of a Groq call.
 * Exposed for callers that need to log costCents directly without a separate
 * mutation roundtrip.
 */
export function groqCostCents(tokensIn: number, tokensOut: number): number {
  const dollars =
    (tokensIn / 1_000_000) * GROQ_TOKENS_IN_PER_M +
    (tokensOut / 1_000_000) * GROQ_TOKENS_OUT_PER_M;
  return dollars * 100;
}

/** Pure helper: compute the cents cost of a Sarvam TTS call. */
export function sarvamCostCents(chars: number): number {
  const dollars = (chars / 1_000_000) * SARVAM_CHARS_PER_M;
  return dollars * 100;
}

// ---------------------------------------------------------------------------
// Insert.
// ---------------------------------------------------------------------------

/**
 * Insert one usage event. Internal — only call from server-side action code.
 *
 * `costCents` is required so partial logging never silently understates spend.
 * Callers that don't want to recompute can pass groqCostCents/sarvamCostCents
 * results directly.
 */
export const record = internalMutation({
  args: {
    userId: v.id("users"),
    kind: v.string(),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    audioMs: v.optional(v.number()),
    chars: v.optional(v.number()),
    costCents: v.number(),
    threadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("usage_events", {
      userId: args.userId,
      kind: args.kind,
      tokensIn: args.tokensIn,
      tokensOut: args.tokensOut,
      audioMs: args.audioMs,
      chars: args.chars,
      costCents: args.costCents,
      threadId: args.threadId,
      ts: Date.now(),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Read aggregator.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ROLLUP_WINDOW_DAYS = 30;
// Hard read ceiling for the rollup query. A user firing 200 frames/day for 30
// days ~ 6k rows; capping at 10k keeps the txn read budget bounded even for
// the heaviest power user without forcing pagination on the read side.
const MAX_ROLLUP_ROWS = 10_000;

type UsageRollup = {
  windowDays: number;
  groqTokensIn: number;
  groqTokensOut: number;
  groqCostCents: number;
  sarvamChars: number;
  sarvamCostCents: number;
  totalCostCents: number;
};

/**
 * Last-30d rollup for the calling user. Reads the by_user_ts index in
 * desc order so the early-exit on `ts < cutoff` saves work when usage is
 * recent (the common case).
 */
export const myUsage = authedQuery({
  args: {},
  handler: async (ctx): Promise<UsageRollup> => {
    const cutoff = Date.now() - ROLLUP_WINDOW_DAYS * MS_PER_DAY;

    const rows = await ctx.db
      .query("usage_events")
      .withIndex("by_user_ts", (q) =>
        q.eq("userId", ctx.userId).gte("ts", cutoff),
      )
      .order("desc")
      .take(MAX_ROLLUP_ROWS);

    let groqTokensIn = 0;
    let groqTokensOut = 0;
    let groqCostCents = 0;
    let sarvamChars = 0;
    let sarvamCostCents = 0;
    let totalCostCents = 0;

    for (const r of rows) {
      totalCostCents += r.costCents;
      if (r.kind.startsWith("groq.")) {
        groqTokensIn += r.tokensIn ?? 0;
        groqTokensOut += r.tokensOut ?? 0;
        groqCostCents += r.costCents;
      } else if (r.kind.startsWith("sarvam.")) {
        sarvamChars += r.chars ?? 0;
        sarvamCostCents += r.costCents;
      }
    }

    return {
      windowDays: ROLLUP_WINDOW_DAYS,
      groqTokensIn,
      groqTokensOut,
      groqCostCents,
      sarvamChars,
      sarvamCostCents,
      totalCostCents,
    };
  },
});
