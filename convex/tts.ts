import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { sarvamTts, groqWhisperAlign } from "./ttsProviders";
import { requireEnvGroup } from "./lib/env";
import { rateLimiter } from "./rateLimiter";
import { sarvamCostCents } from "./usage";

export const generateAudio = internalAction({
  args: {
    narration: v.string(),
    explanationId: v.id("explanations"),
  },
  handler: async (ctx, { narration, explanationId }): Promise<null> => {
    requireEnvGroup(["SARVAM_API_KEY", "GROQ_API_KEY"]);

    // Look up the owning user so we can rate-limit per-user, not globally.
    // Missing explanation = mutation was deleted; skip quietly.
    const owner = await ctx.runQuery(internal.explanations.getOwner, {
      explanationId,
    });
    if (!owner) {
      console.warn(`[TTS] explanation ${explanationId} not found — skipping`);
      return null;
    }

    // Anonymous users get the tighter quota (Sarvam minutes are expensive +
    // a fresh anon user can be minted unboundedly per hour subject only to
    // the global anonymousSignup gate). Authed users get the standard cap.
    // Both branches still chain the per-minute floor so a single user's
    // parallel sub-agent storm can't burst past 20 syntheses/min.
    const anon = await ctx.runQuery(internal.users.isAnonymous, { userId: owner });
    const hourlyKind = anon ? "ttsPerAnonymousUser" : "ttsPerUser";

    const hourly = await rateLimiter.limit(ctx, hourlyKind, { key: owner });
    if (!hourly.ok) {
      console.warn(
        `[TTS] hourly limit (${hourlyKind}) hit for user ${owner} (retry in ${hourly.retryAfter}ms) — skipping synthesis`,
      );
      return null;
    }
    const perMinute = await rateLimiter.limit(ctx, "ttsPerUserMinute", {
      key: owner,
    });
    if (!perMinute.ok) {
      console.warn(
        `[TTS] per-minute limit hit for user ${owner} (retry in ${perMinute.retryAfter}ms) — skipping synthesis`,
      );
      return null;
    }

    try {
      const { audioBytes, mimeType } = await sarvamTts(narration);
      const storageId = await ctx.storage.store(
        new Blob([audioBytes as BlobPart], { type: mimeType }),
      );
      const timings = await groqWhisperAlign(audioBytes, mimeType);

      await ctx.runMutation(internal.explanations.patchAudio, {
        explanationId,
        audioStorageId: storageId,
        audioTimings: JSON.stringify(timings),
      });

      // Usage telemetry — Sarvam billed per-character, Whisper per-second of
      // audio. Two rows so the rollup query can split provider lines.
      // Failure-tolerant: log only, never block the audio path.
      try {
        const audioMs =
          (timings.wtimes.at(-1) ?? 0) + (timings.wdurations.at(-1) ?? 0);
        await ctx.runMutation(internal.usage.record, {
          userId: owner,
          kind: "sarvam.tts",
          chars: narration.length,
          costCents: sarvamCostCents(narration.length),
          threadId: undefined,
        });
        await ctx.runMutation(internal.usage.record, {
          userId: owner,
          kind: "groq.whisper",
          audioMs,
          // Whisper price is per-minute of audio at $0.04/min for
          // whisper-large-v3 on Groq; convert audioMs → cents.
          costCents: (audioMs / 60_000) * 0.04 * 100,
        });
      } catch (telErr) {
        console.warn(
          `[TTS] usage telemetry failed (non-fatal): ${
            telErr instanceof Error ? telErr.message : String(telErr)
          }`,
        );
      }
      return null;
    } catch (err) {
      console.error(`[TTS] generateAudio failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  },
});
