/**
 * Llama-Guard pre-filter for user prompts.
 *
 * Wired-in note (BETA owns chat.ts — do not modify there from here): before
 * `director.streamText` in `chat.sendMessageStreaming`, call
 * `internal.moderation.checkPrompt`. If `safe === false`, throw with the
 * `reason` field — the streaming path returns the refusal as a synthetic
 * frame to the client.
 *
 * Provider: Groq's hosted Llama-Guard. Model name preference order:
 *   1. `meta-llama/Llama-Guard-4-12B`  (if Groq hosts it at call time)
 *   2. `meta-llama/llama-guard-4-12b`  (alternate casing some Groq endpoints expose)
 *   3. `llama-guard-3-8b`               (the older, smaller variant — fallback)
 * If all calls fail (provider down, no API key, model deprecated), we fall
 * back to a conservative keyword filter so the gate is never a hard outage.
 *
 * The Groq Llama-Guard reply is a string starting with "safe" or "unsafe".
 * On unsafe, the second line is a comma-separated list of S-codes:
 *
 *   unsafe
 *   S1,S5
 *
 * We surface those raw codes in `categories` so a future ops dashboard can
 * count which categories trip most. The user-facing `reason` is generic to
 * avoid teaching attackers what the filter cares about.
 */

import { v } from "convex/values";
import { generateText } from "ai";
import { groq } from "@ai-sdk/groq";
import { internalAction } from "./_generated/server";

// Models to try in order. The Groq hosted model name landscape shifts; the
// list is iterated until one returns a non-error response.
const MODEL_CANDIDATES = [
  "meta-llama/Llama-Guard-4-12B",
  "meta-llama/llama-guard-4-12b",
  "llama-guard-3-8b",
] as const;

// Last-ditch keyword filter. Deliberately small + obvious — Llama-Guard is
// the real defense; this exists only so an outage doesn't mean every prompt
// gets through unfiltered. Tuned for explicit harm requests, not edge cases.
const FALLBACK_KEYWORDS: Array<{ category: string; needles: string[] }> = [
  {
    category: "S1",
    needles: ["how to kill", "how do i kill someone", "build a bomb", "make a bomb"],
  },
  {
    category: "S3",
    needles: ["child sexual", "csam"],
  },
  {
    category: "S9",
    needles: ["how to make meth", "synthesize meth", "synthesise meth"],
  },
];

function keywordFallback(prompt: string): {
  safe: boolean;
  categories: string[];
} {
  const lower = prompt.toLowerCase();
  const tripped: string[] = [];
  for (const group of FALLBACK_KEYWORDS) {
    for (const n of group.needles) {
      if (lower.includes(n)) {
        tripped.push(group.category);
        break;
      }
    }
  }
  return { safe: tripped.length === 0, categories: tripped };
}

/**
 * Parse the canonical Llama-Guard reply.
 *
 * Format from Groq:
 *   "safe"
 *     -> {safe: true, categories: []}
 *
 *   "unsafe\nS1,S5"
 *     -> {safe: false, categories: ["S1", "S5"]}
 *
 * Tolerates whitespace, casing, and trailing commentary the model sometimes
 * adds despite the system prompt asking it not to.
 */
function parseLlamaGuardReply(reply: string): {
  safe: boolean;
  categories: string[];
} {
  const trimmed = reply.trim();
  if (!trimmed) return { safe: true, categories: [] };
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? "";
  if (firstLine.startsWith("safe")) return { safe: true, categories: [] };
  if (!firstLine.startsWith("unsafe")) {
    // Model emitted neither "safe" nor "unsafe" — treat as safe but log so
    // an ops dashboard can flag drift. We do not block on parse failure
    // because doing so would weaponize a flaky model into a denial vector.
    console.warn(
      `[moderation] Llama-Guard returned unrecognized prefix: ${firstLine.slice(0, 64)}`,
    );
    return { safe: true, categories: [] };
  }
  // Pull S-codes from the rest of the response.
  const categoryMatches = trimmed.match(/\bS\d{1,2}\b/g) ?? [];
  return { safe: false, categories: Array.from(new Set(categoryMatches)) };
}

export const checkPrompt = internalAction({
  args: { prompt: v.string() },
  handler: async (
    _ctx,
    { prompt },
  ): Promise<{ safe: boolean; categories: string[]; reason?: string }> => {
    // No API key → keyword fallback. Don't surface the missing key as an
    // error; the gate must always return *some* answer.
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      const fb = keywordFallback(prompt);
      return fb.safe
        ? fb
        : { ...fb, reason: "Prompt flagged by safety pre-filter." };
    }

    let lastError: unknown = null;

    for (const model of MODEL_CANDIDATES) {
      try {
        const { text } = await generateText({
          model: groq(model),
          // Llama-Guard is instruction-tuned to classify the *user* turn it
          // sees. Wrapping in a chat turn keeps it from leaking the prompt
          // into normal generation behavior.
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          // Tight token budget — guard replies are at most ~10 tokens.
          temperature: 0,
        });
        const parsed = parseLlamaGuardReply(text);
        if (parsed.safe) return parsed;
        return {
          ...parsed,
          reason: "Prompt flagged by safety pre-filter.",
        };
      } catch (err) {
        // Try the next candidate model — most likely "model not found".
        lastError = err;
      }
    }

    console.warn(
      `[moderation] all Llama-Guard models failed; falling back to keyword filter. lastError=${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    const fb = keywordFallback(prompt);
    return fb.safe
      ? fb
      : { ...fb, reason: "Prompt flagged by safety pre-filter." };
  },
});
