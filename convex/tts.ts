import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { sarvamTts, groqWhisperAlign } from "./ttsProviders";

export const generateAudio = internalAction({
  args: {
    narration: v.string(),
    explanationId: v.id("explanations"),
  },
  handler: async (ctx, { narration, explanationId }): Promise<null> => {
    if (!process.env.SARVAM_API_KEY || !process.env.GROQ_API_KEY) {
      throw new Error("Missing SARVAM_API_KEY / GROQ_API_KEY");
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
      return null;
    } catch (err) {
      console.error(`[TTS] generateAudio failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  },
});
