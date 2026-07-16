/**
 * Shared ActionCache handles. Keep cache namespaces versioned (e.g. "intro-v1")
 * so a change in the underlying prompt invalidates every stored entry instead
 * of silently serving stale generations.
 */

import { ActionCache } from "@convex-dev/action-cache";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { generateText } from "ai";
import { utilityTextModel } from "./lib/models";

const HOUR = 1000 * 60 * 60;

/**
 * Pure LLM call for the warm intro paragraph. Deterministic on (prompt,
 * system-prompt) so it's safe to cache for a day — identical question text
 * reuses the same text + saves ~1s and one Groq call.
 */
export const generateIntroText = internalAction({
  args: { prompt: v.string() },
  handler: async (_ctx, { prompt }): Promise<string> => {
    const { text } = await generateText({
      model: utilityTextModel(),
      system:
        "You are a friendly learning assistant. Given the user's question, generate a warm 2-4 sentence introduction that acknowledges their question and gives a simple, accessible overview of the topic. Keep it under 60 words. Do not use markdown.",
      prompt,
    });
    return text;
  },
});

export const introTextCache = new ActionCache(components.actionCache, {
  action: internal.cache.generateIntroText,
  name: "intro-text-v1",
  ttl: HOUR * 24,
});
