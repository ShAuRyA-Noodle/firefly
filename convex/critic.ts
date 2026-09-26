/**
 * [lambda] Segment critic — Newspapering Pattern 2 (execute → critique → revise).
 *
 * The critic audits a single rendered frame BEFORE it lands in the
 * explanations table. It catches the failure modes the user has been
 * complaining about:
 *   - wrong medium for the question (e.g. ui card for a math derivation)
 *   - duplicate idea across frames
 *   - narration claiming things the config doesn't show
 *   - low-density frames
 *
 * The critic is FAIL-OPEN by design. Convex action timeouts, malformed
 * JSON, missing API key, quota errors — every degenerate path returns
 * `{ ok: true, issues: [] }` so a critic outage never blocks a frame.
 *
 * Model choice: llama-3.3-70b-versatile (Groq). gpt-oss-120b is overkill
 * for a one-line classification + at most three short labels, and the
 * smaller model is cheaper + faster, which matters when this runs on the
 * critical path of every sub-agent.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { generateText } from "ai";
import { internal } from "./_generated/api";
import { groqCostCents } from "./usage";
import { utilityTextModel, hasTextProvider } from "./lib/models";

const CRITIC_SYSTEM_PROMPT = `You audit a single frame in a multi-frame visual explanation. Inputs:
- segment prompt: what the director asked the sub-agent to render
- skill: the medium chosen
- config + narration: what the sub-agent produced
- prior frame skills: media used by previous frames

Return STRICT JSON one line: {"ok": bool, "issues": [string, ...]}
issues is empty when ok=true. When ok=false, list 1-3 short issues:
- "wrong medium" if the skill is a poor fit (e.g. ui card for a math derivation)
- "duplicate idea" if the same concept is covered by a prior frame
- "narration mismatch" if the spoken script claims something the config doesn't show
- "low density" if a frame has near-empty content
ok=true if the frame is broadly fine. Be lenient — only flag real problems.`;

type CriticVerdict = { ok: boolean; issues: string[] };

/**
 * [lambda] Critic verdict for one frame.
 *
 * Returns `{ok: true, issues: []}` on EVERY failure mode (no API key,
 * Groq error, malformed JSON, schema mismatch). This is intentional —
 * the critic is best-effort improvement, never a gate.
 */
export const judgeFrame = internalAction({
  args: {
    skill: v.string(),
    configJson: v.string(),
    narration: v.string(),
    segmentPrompt: v.string(),
    priorFrameSkills: v.array(v.string()),
    // Optional — used only for usage telemetry. The critic is safe to
    // call without it (telemetry just gets skipped).
    userId: v.optional(v.id("users")),
    threadId: v.optional(v.string()),
  },
  returns: v.object({
    ok: v.boolean(),
    issues: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<CriticVerdict> => {
    // Fail-open #1: no text provider configured → skip critic entirely.
    // Avoids both a noisy error log AND a fake "ok: true" that lies about
    // having run.
    if (!hasTextProvider()) {
      return { ok: true, issues: [] };
    }

    // Truncate config for the LLM. Massive Excalidraw configs (256
    // elements) can blow past the input budget; the critic only needs
    // a representative sample to judge medium fit + duplication.
    const configForPrompt = args.configJson.slice(0, 4000);

    const userPrompt = [
      `segment prompt: ${args.segmentPrompt}`,
      `skill: ${args.skill}`,
      `prior frame skills: ${
        args.priorFrameSkills.length > 0
          ? args.priorFrameSkills.join(", ")
          : "(none — this is the first frame)"
      }`,
      `narration: ${args.narration}`,
      `config: ${configForPrompt}`,
    ].join("\n\n");

    let text: string;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    try {
      const result = await generateText({
        model: utilityTextModel(),
        system: CRITIC_SYSTEM_PROMPT,
        prompt: userPrompt,
        temperature: 0,
      });
      text = result.text;
      usage = result.usage;
    } catch (err) {
      console.warn("[critic] generateText failed (fail-open):", err);
      return { ok: true, issues: [] };
    }

    // Best-effort usage record. Wrapped in try so a telemetry hiccup never
    // blocks the critic verdict.
    if (args.userId && usage) {
      try {
        const tokensIn = usage.inputTokens ?? 0;
        const tokensOut = usage.outputTokens ?? 0;
        await ctx.runMutation(internal.usage.record, {
          userId: args.userId,
          kind: "groq.critic",
          tokensIn,
          tokensOut,
          costCents: groqCostCents(tokensIn, tokensOut),
          threadId: args.threadId,
        });
      } catch (err) {
        console.warn("[critic] usage.record failed (non-fatal):", err);
      }
    }

    const parsed = parseCriticVerdict(text);
    if (!parsed) {
      return { ok: true, issues: [] };
    }
    return parsed;
  },
});

/**
 * [lambda] Tolerant parser. Handles bare JSON, ```json fences, prose-then-JSON
 * — the same shape memoryExtract.ts learned to expect from Groq llama.
 *
 * Returns null on every failure; caller treats null as fail-open.
 */
function parseCriticVerdict(text: string): CriticVerdict | null {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");

  const candidates: string[] = [unfenced];
  // Last-ditch: extract first {...} span if the model emitted prose before/after.
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (match && match[0] !== unfenced) candidates.push(match[0]);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.ok === "boolean" &&
        Array.isArray(obj.issues) &&
        obj.issues.every((s: unknown) => typeof s === "string")
      ) {
        // Cap issue list defensively — the LLM was instructed 1-3 but a
        // misbehaving model could produce an unbounded array.
        const issues = (obj.issues as string[]).slice(0, 5);
        return { ok: obj.ok, issues };
      }
    } catch {
      continue;
    }
  }
  return null;
}
