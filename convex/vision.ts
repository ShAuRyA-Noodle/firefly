/**
 * Vision OCR + question extraction.
 *
 * Pipeline:
 *   1. Client uploads an image via the signed PUT URL minted by
 *      `generateUploadUrl` (wraps `ctx.storage.generateUploadUrl()`).
 *   2. Convex returns `{ storageId }` from the POST response. Client passes
 *      that to `chat.sendImageMessage`, which calls
 *      `internal.vision.extractQuestion` here to OCR the image with a
 *      Groq vision model.
 *   3. Models are tried in order. First non-empty, non-"NO_QUESTION_FOUND"
 *      reply wins. All-fail returns `{ question: null, model: "fallback" }`.
 *
 * Defense-in-depth (server-side, redundant with the client filter):
 *   - MIME whitelist (PNG/JPEG/WEBP/GIF). Blob.type can be empty or spoofed
 *     by a malicious client; we treat empty type as a soft pass (vision
 *     model will still reject non-images) but reject any `image/*` not on
 *     the whitelist outright.
 *   - 10 MB hard byte limit. Convex storage has its own limits but we cap
 *     here so a giant image can't burn vision tokens.
 *   - Moderation pre-filter on the EXTRACTED question text — same gate
 *     `chat.sendMessageStreaming` runs against typed prompts.
 *   - Usage telemetry tagged `groq.vision` so the rollup splits cost.
 *
 * Rate limiting (`dailyQuestions`) is enforced upstream in
 * `chat.sendImageMessage` because that's where the userId auth context
 * lives — internal actions don't carry auth automatically.
 */

import { v } from "convex/values";
import { generateText } from "ai";
import { groq } from "@ai-sdk/groq";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authedAction } from "./lib/functions";
import { groqCostCents } from "./usage";
import { optionalEnv } from "./lib/env";
import type { Id } from "./_generated/dataModel";

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

// Vision-capable Groq models. The list shifts over time; iterate until one
// returns a non-error response. An override env (`GROQ_VISION_MODEL`)
// jumps the queue so ops can pin to a specific model without a redeploy.
const VISION_MODEL_CANDIDATES = [
  "meta-llama/Llama-4-Scout-17B-16E-Instruct",
  "llama-3.2-90b-vision-preview",
  "llama-3.2-11b-vision-preview",
] as const;

const VISION_SYSTEM_PROMPT = `You are an OCR + question extractor. Read the image. If it contains a textbook page, problem, or handwritten question, output ONLY the question text the user is asking — no commentary. If the image contains no question, output 'NO_QUESTION_FOUND'.`;

/**
 * Mints a signed upload URL the client posts to. Public action so the
 * client can call it via `useAction(api.vision.generateUploadUrl)`. Auth
 * gate ensures only signed-in users can request upload slots.
 */
export const generateUploadUrl = authedAction({
  args: {},
  handler: async (ctx): Promise<string> => {
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Reads the uploaded image, asks the vision model what question it
 * contains, returns the extracted text (or null if nothing readable).
 *
 * Internal — only called from `chat.sendImageMessage` after the caller
 * has been authed + rate-limited + thread-ownership checked.
 */
export const extractQuestion = internalAction({
  args: { storageId: v.id("_storage"), userId: v.id("users") },
  handler: async (
    ctx,
    { storageId, userId },
  ): Promise<{ question: string | null; model: string }> => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) {
      throw new Error("Uploaded image not found in storage");
    }

    // MIME defense in depth. The client-side picker filters by accept=
    // and the dragdrop overlay rejects non-images, but neither stops a
    // motivated attacker who calls the action directly. Empty mime is
    // permitted (some browsers don't set it on paste); the vision model
    // will reject true non-images via NO_QUESTION_FOUND. Any explicit
    // image/* outside the allowlist is rejected — covers image/svg+xml
    // (script-injection vector for some downstream consumers) and
    // image/heic/heif (vision models choke on these).
    const mime = (blob.type || "").toLowerCase();
    if (mime && mime.startsWith("image/") && !ALLOWED_MIME_TYPES.has(mime)) {
      throw new Error(
        `Unsupported image type: ${mime}. Use PNG, JPEG, WEBP, or GIF.`,
      );
    }
    if (mime && !mime.startsWith("image/")) {
      throw new Error(
        "That file isn't an image. Upload a photo or screenshot.",
      );
    }

    const arrayBuf = await blob.arrayBuffer();
    if (arrayBuf.byteLength === 0) {
      throw new Error("Uploaded image is empty");
    }
    if (arrayBuf.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)} MB). Max 10 MB.`,
      );
    }
    const bytes = new Uint8Array(arrayBuf);
    // Effective mime for the vision model — fall back to png when blob.type
    // is missing. The Groq vision endpoint requires a known type.
    const effectiveMime = ALLOWED_MIME_TYPES.has(mime) ? mime : "image/png";

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      // No key → no vision. Return null so the caller surfaces a generic
      // "couldn't read" UX instead of leaking a config error to the user.
      console.warn("[vision] GROQ_API_KEY missing — skipping vision call");
      return { question: null, model: "fallback" };
    }

    // Env override jumps the candidate queue. Pinned model is tried first;
    // standard candidates after, deduped.
    const override = optionalEnv("GROQ_VISION_MODEL", "");
    const candidates: string[] = override
      ? [override, ...VISION_MODEL_CANDIDATES.filter((m) => m !== override)]
      : [...VISION_MODEL_CANDIDATES];

    let lastError: unknown = null;
    let extractedText: string | null = null;
    let usedModel = "fallback";
    let modelSucceeded = false;

    for (const model of candidates) {
      try {
        const { text } = await generateText({
          model: groq(model),
          system: VISION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Extract the question from this image. Output the question text only.",
                },
                {
                  type: "image",
                  image: bytes,
                  mediaType: effectiveMime,
                },
              ],
            },
          ],
          temperature: 0,
        });

        modelSucceeded = true;
        usedModel = model;
        const cleaned = (text ?? "").trim();
        // The system prompt instructs the model to emit
        // 'NO_QUESTION_FOUND' as a sentinel rather than a refusal — match
        // case-insensitively + substring so wrapping quotes / whitespace
        // don't slip past the gate.
        if (
          !cleaned ||
          cleaned.toLowerCase().includes("no_question_found")
        ) {
          extractedText = null;
        } else {
          extractedText = cleaned;
        }
        break;
      } catch (err) {
        lastError = err;
        // Try next candidate — most likely "model not found" or transient.
        continue;
      }
    }

    if (!modelSucceeded) {
      console.warn(
        `[vision] all models failed; lastError=${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    }

    // Usage telemetry — vision pricing is a moving target; estimate input
    // tokens conservatively (image ≈ 1k tokens, prompt overhead ≈ 50) and
    // output by extracted-text length. Best-effort; failure non-fatal.
    try {
      const tokensIn = 1050;
      const tokensOut = Math.ceil((extractedText?.length ?? 0) / 4);
      await ctx.runMutation(internal.usage.record, {
        userId: userId as Id<"users">,
        kind: "groq.vision",
        tokensIn,
        tokensOut,
        costCents: groqCostCents(tokensIn, tokensOut),
      });
    } catch {
      // swallow — telemetry never blocks the user path
    }

    if (extractedText !== null) {
      // Run the same safety gate that text questions go through. Vision
      // is a vector for "render the prompt as an image" jailbreaks; we
      // re-filter at the *extracted text* level. A flagged extraction
      // throws, matching `sendMessageStreaming`'s contract.
      const safety: { safe: boolean; categories: string[]; reason?: string } =
        await ctx.runAction(internal.moderation.checkPrompt, {
          prompt: extractedText,
        });
      try {
        const tokensIn = Math.ceil(extractedText.length / 4);
        await ctx.runMutation(internal.usage.record, {
          userId: userId as Id<"users">,
          kind: "groq.moderation",
          tokensIn,
          tokensOut: 10,
          costCents: groqCostCents(tokensIn, 10),
        });
      } catch {
        // swallow — telemetry must never block the user path
      }
      if (!safety.safe) {
        throw new Error(safety.reason ?? "Prompt blocked by safety filter");
      }
    }

    return { question: extractedText, model: usedModel };
  },
});
