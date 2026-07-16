/**
 * Per-user UI/voice preferences. One row per user, upserted via `setMine`.
 *
 * Voice options come from Sarvam — keeping the allowlist server-side prevents
 * a malicious client from poisoning the row with a bogus voice id that would
 * later 4xx every TTS call. Speed is clamped server-side too; the slider in
 * the settings UI is just a hint.
 *
 * Patch semantics: only fields explicitly provided in args overwrite existing
 * values. `undefined` means "leave alone", not "clear". This matches the
 * settings page's per-control save UX where individual toggles change without
 * resending the entire prefs object.
 */
import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/functions";

// Sarvam voices — keep in sync with the picker in src/routes/settings.tsx
// and the TTS provider config in convex/ttsProviders.ts. If you add a voice
// here, also add it to those two surfaces.
const ALLOWED_VOICES = [
  "anushka",
  "manisha",
  "vidya",
  "arya",
  "abhilash",
  "karun",
  "hitesh",
] as const;

// Sarvam supports a handful of Indian languages. en-IN is the default for
// English narration since Sarvam's en-IN voices outperform plain `en`.
const ALLOWED_LANGUAGES = [
  "en-IN",
  "hi-IN",
  "bn-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "gu-IN",
] as const;

const ALLOWED_THEMES = ["dark", "light"] as const;

export const getMine = authedQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", ctx.userId))
      .unique();
    return row;
  },
});

export const setMine = authedMutation({
  args: {
    voice: v.optional(v.string()),
    voiceLanguage: v.optional(v.string()),
    autoplay: v.optional(v.boolean()),
    narrationSpeed: v.optional(v.number()),
    theme: v.optional(v.string()),
    reducedMotion: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Validate every provided field server-side. Each branch throws so the
    // mutation aborts atomically — partial updates with one valid + one bad
    // field would otherwise silently persist the valid one.
    if (args.voice !== undefined) {
      if (!ALLOWED_VOICES.includes(args.voice as (typeof ALLOWED_VOICES)[number])) {
        throw new Error(
          `voice must be one of: ${ALLOWED_VOICES.join(", ")}`,
        );
      }
    }
    if (args.voiceLanguage !== undefined) {
      if (
        !ALLOWED_LANGUAGES.includes(
          args.voiceLanguage as (typeof ALLOWED_LANGUAGES)[number],
        )
      ) {
        throw new Error(
          `voiceLanguage must be one of: ${ALLOWED_LANGUAGES.join(", ")}`,
        );
      }
    }
    if (args.narrationSpeed !== undefined) {
      if (
        typeof args.narrationSpeed !== "number" ||
        Number.isNaN(args.narrationSpeed) ||
        args.narrationSpeed < 0.5 ||
        args.narrationSpeed > 2.0
      ) {
        throw new Error("narrationSpeed must be a number in [0.5, 2.0]");
      }
    }
    if (args.theme !== undefined) {
      if (!ALLOWED_THEMES.includes(args.theme as (typeof ALLOWED_THEMES)[number])) {
        throw new Error(`theme must be one of: ${ALLOWED_THEMES.join(", ")}`);
      }
    }

    // Only patch the fields the caller actually sent. Spread-with-undefined
    // would overwrite stored values with undefined and leak intent.
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.voice !== undefined) patch.voice = args.voice;
    if (args.voiceLanguage !== undefined) patch.voiceLanguage = args.voiceLanguage;
    if (args.autoplay !== undefined) patch.autoplay = args.autoplay;
    if (args.narrationSpeed !== undefined) patch.narrationSpeed = args.narrationSpeed;
    if (args.theme !== undefined) patch.theme = args.theme;
    if (args.reducedMotion !== undefined) patch.reducedMotion = args.reducedMotion;

    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", ctx.userId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return null;
    }
    await ctx.db.insert("userPreferences", {
      userId: ctx.userId,
      ...patch,
    });
    return null;
  },
});
