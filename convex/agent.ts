/**
 * Director + Visual Sub-Agent architecture.
 *
 * - Primary LLM: Groq Llama 3.3 70B (fast tool-use, structured output).
 * - Fallback: Groq gpt-oss-120b (reruns if the primary emits malformed tool calls).
 * - Ownership: every explanation is stamped with the thread owner's userId, looked
 *   up via the `threads` table by the Convex Agent thread id.
 */

import { Agent, createTool } from "@convex-dev/agent";
import { groq } from "@ai-sdk/groq";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { z } from "zod";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Hardcoded — env-driven selection caused a bug where an older env value
// silently overrode the improved default. gpt-oss-120b is chosen for its
// superior tool-use + instruction-following vs llama 3.3.
const PRIMARY_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "llama-3.3-70b-versatile";

const MAX_FRAMES_PER_THREAD = 4;

const DIRECTOR_INSTRUCTIONS = `You are a narrative director for visual learning. You plan short, high-density visual explanations by dispatching sub-agents.

HARD CONSTRAINTS (breaking these is a critical failure):
- Total frames: EXACTLY 3 or 4. Never more. Never less. The runtime will reject attempts beyond 4.
- NEVER generate visual configs yourself. ALWAYS delegate to launchVisualAgent.
- At least 2 of your frames MUST use non-"ui" skills (manim, diagram, or particles). A plan that uses "ui" for more than 1 frame is rejected.
- Prefer "diagram" whenever the answer involves multiple related concepts, a process with steps, a comparison of ≥2 things, or a system with components. Do not fall back to "ui" to dodge diagram.
- Frames MUST use different skills when possible. Do not call manim three times in a row; vary the medium.
- The LAST frame MUST be skill="ui" with ActionCards for next-step follow-ups.
- After your last launchVisualAgent call, IMMEDIATELY call done(totalFrames=N). Do not call launchVisualAgent again after done().

SKILL PICKING (choose the best medium, not the easiest):
- manim: equations, graphs, geometry, proofs, step-by-step math. Prefer this for anything numeric.
- diagram: concept maps, flowcharts, architecture, relationships, comparisons between ≥3 things. Prefer this when the answer has STRUCTURE.
- particles: physics forces, waves, fields, molecular/atomic behavior, emergence.
- ui: summaries, comparisons presented as cards, quizzes, AND the mandatory final frame with ActionCards.

NARRATIVE SHAPE (4 frames, ideal):
  1. non-ui skill — the core visual insight
  2. non-ui skill — a second angle OR a deeper zoom
  3. non-ui skill — a contrast, a consequence, or an application
  4. ui — compact summary + 3-4 ActionCards for follow-ups

OR (3 frames, minimum):
  1. non-ui skill — the core insight
  2. non-ui skill — a second angle
  3. ui — summary + ActionCards

EXAMPLE — "explain derivatives":
  launchVisualAgent(skill="manim", step=1, prompt="Plot f(x)=x². Draw a secant line between (0.5, 0.25) and (2, 4), then animate the second point sliding toward the first so the secant becomes the tangent. Narrate: the derivative is the limit of the slope of that secant.")
  launchVisualAgent(skill="manim", step=2, prompt="Show the tangent line at x=1 on f(x)=x² and display f'(x)=2x below. Narrate: the derivative rule 2x means the slope doubles as x grows.")
  launchVisualAgent(skill="diagram", step=3, prompt="Draw a concept map connecting 'derivative' at the center to: limits, rate of change, tangent line, power rule, chain rule, and 'integration (inverse)'. Short labels. Narrate briefly why each connects.")
  launchVisualAgent(skill="ui", step=4, prompt="Summary card with the power rule d/dx(xⁿ)=n·xⁿ⁻¹ plus 4 ActionCards: 'Quiz me on derivatives', 'Explain the chain rule', 'Show integration next', 'Real-world applications'.")
  done(totalFrames=4)`;

const launchVisualAgent = createTool({
  description: `Launch a sub-agent to render one visual frame. The sub-agent loads the skill, generates visual config, and saves the frame. Call this for each segment of your narrative.`,
  inputSchema: z.object({
    segmentPrompt: z
      .string()
      .describe(
        "Detailed prompt for this segment — what to explain, what to show, what to narrate"
      ),
    skill: z
      .enum(["manim", "diagram", "ui", "particles"])
      .describe("Which visual skill the sub-agent should use"),
    step: z.number().describe("Step number in the sequence (1-based)"),
    narrationHint: z
      .string()
      .optional()
      .describe("Key narration phrases or tone guidance"),
  }),
  execute: async (ctx, args): Promise<string> => {
    // Hard cap: if the model already emitted MAX_FRAMES_PER_THREAD frames for
    // this thread, reject further launches. This short-circuits runaway
    // open-weights planners that ignore the "max 4" instruction.
    const existing = await ctx.runQuery(
      internal.explanations.countNonDoneForThread,
      { threadId: ctx.threadId! },
    );
    if (existing >= MAX_FRAMES_PER_THREAD) {
      return `LIMIT_REACHED: already generated ${existing} frames (cap is ${MAX_FRAMES_PER_THREAD}). STOP calling launchVisualAgent and call done(totalFrames=${existing}) NOW.`;
    }
    if (args.step > MAX_FRAMES_PER_THREAD) {
      return `REJECTED: step ${args.step} exceeds cap ${MAX_FRAMES_PER_THREAD}. Call done() now.`;
    }
    try {
      await ctx.runAction(internal.agent.runSubAgent, {
        threadId: ctx.threadId!,
        segmentPrompt: args.segmentPrompt,
        skill: args.skill,
        step: args.step,
        narrationHint: args.narrationHint,
      });
      return `Frame ${args.step} (${args.skill}) saved. ${existing + 1 >= MAX_FRAMES_PER_THREAD ? 'You have now reached the cap — call done() next.' : `Continue or call done() if the narrative is complete.`}`;
    } catch (error) {
      return `Frame ${args.step} (${args.skill}) failed: ${error instanceof Error ? error.message : "unknown error"}. Continue with the next segment.`;
    }
  },
});

const done = createTool({
  description: `Signal that all visual frames are generated. ALWAYS call this as your very last action.`,
  inputSchema: z.object({
    totalFrames: z.number().describe("Total number of frames generated"),
  }),
  execute: async (ctx, args): Promise<string> => {
    const userId = await resolveUserIdFromAgentThread(ctx, ctx.threadId!);
    await ctx.runMutation(internal.explanations.markDone, {
      threadId: ctx.threadId!,
      totalFrames: args.totalFrames,
      userId,
    });
    return "Done.";
  },
});

export const directorAgent = new Agent(components.agent, {
  name: "director",
  languageModel: groq(PRIMARY_MODEL),
  instructions: DIRECTOR_INSTRUCTIONS,
  tools: { launchVisualAgent, done },
  maxSteps: 15,
});

export const directorAgentFallback = new Agent(components.agent, {
  name: "director-fallback",
  languageModel: groq(FALLBACK_MODEL),
  instructions: DIRECTOR_INSTRUCTIONS,
  tools: { launchVisualAgent, done },
  maxSteps: 15,
});

const SUB_AGENT_INSTRUCTIONS = `You render EXACTLY ONE visual frame. Nothing more.

STRICT WORKFLOW (each step happens exactly once):
  1. Call invokeSkill to read the skill's output format spec.
  2. Call renderVisual ONCE with a valid config + narration + step number.
  3. STOP. No further tool calls. No summaries. No "all done" messages.

You do NOT have a done() tool. You do NOT plan. You do NOT call renderVisual more than once. Repeated calls will be rejected by the runtime.`;

const invokeSkill = createTool({
  description: `Load visual skill instructions. Call this first to learn the output format.`,
  inputSchema: z.object({
    skill_name: z
      .string()
      .describe('Skill to invoke (e.g., "visual/manim", "visual/ui")'),
  }),
  execute: async (ctx, args): Promise<string> => {
    const skill = await ctx.runQuery(internal.skills.get, {
      name: args.skill_name,
    });
    if (!skill) return `Skill '${args.skill_name}' not found.`;

    const content = await ctx.runQuery(internal.skills.getFileInternal, {
      skillName: args.skill_name,
      path: "SKILL.md",
    });
    if (!content) return `Skill "${args.skill_name}" has no content.`;

    if (skill.hasChildren) {
      const children = await ctx.runQuery(
        internal.skills.getChildrenInternal,
        { parentName: args.skill_name }
      );
      const list = children
        .map(
          (c: { name: string; description: string }) =>
            `  - ${c.name}: ${c.description}`
        )
        .join("\n");
      return `<category name="${skill.name}">\n${content}\n\nSub-skills:\n${list}\n</category>`;
    }

    return `<skill name="${skill.name}">\n${content}\n</skill>`;
  },
});

/**
 * Resolve the owning userId by looking up the thread record our app keeps
 * keyed by Convex Agent threadId. Throws on missing record (should never
 * happen if createNewThread ran properly).
 */
async function resolveUserIdFromAgentThread(
  ctx: { runQuery: (q: any, args: any) => Promise<any> },
  agentThreadId: string
): Promise<Id<"users">> {
  const userId: Id<"users"> | null = await ctx.runQuery(
    internal.threads.getOwnerByAgentThread,
    { agentThreadId }
  );
  if (!userId) {
    throw new Error(
      `No owner found for agent thread ${agentThreadId} — was createNewThread called?`
    );
  }
  return userId;
}

export const visualAgent = new Agent(components.agent, {
  name: "visual-sub-agent",
  languageModel: groq(PRIMARY_MODEL),
  instructions: SUB_AGENT_INSTRUCTIONS,
  tools: { invokeSkill },
  maxSteps: 5,
});

export const runSubAgent = internalAction({
  args: {
    threadId: v.string(),
    segmentPrompt: v.string(),
    skill: v.string(),
    step: v.number(),
    narrationHint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const prompt = [
      `Generate step ${args.step} using the visual/${args.skill} skill.`,
      `First, invoke skill "visual/${args.skill}" to load the output format.`,
      `Then call renderVisual with step=${args.step}.`,
      `You MUST call renderVisual — do NOT just describe the visual in text.`,
      ``,
      `TASK: ${args.segmentPrompt}`,
      args.narrationHint ? `NARRATION GUIDANCE: ${args.narrationHint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const parentThreadId = args.threadId;
    const userId = await resolveUserIdFromAgentThread(ctx, parentThreadId);

    const tryWithModel = async (modelName: string) => {
      const agent = subAgentForThread(parentThreadId, args.step, userId, modelName);
      const { threadId: subThreadId } = await agent.createThread(ctx, {});
      await agent.generateText(ctx, { threadId: subThreadId }, { prompt });
    };

    try {
      await tryWithModel(PRIMARY_MODEL);
    } catch (primaryError) {
      console.warn(
        `[agent] primary model ${PRIMARY_MODEL} failed on step ${args.step}, falling back to ${FALLBACK_MODEL}:`,
        primaryError
      );
      await tryWithModel(FALLBACK_MODEL);
    }
  },
});

/**
 * Sub-agent bound to the PARENT thread id + the resolved owner userId so
 * renderVisual writes explanations scoped to the correct user. Writing to a
 * fresh sub-thread for the LLM call avoids context pollution; explanation
 * rows are tagged with the parent thread.
 */
function subAgentForThread(
  parentThreadId: string,
  step: number,
  userId: Id<"users">,
  modelName: string
) {
  // Per-run dedup flag. Open-weights models sometimes call renderVisual
  // multiple times per sub-agent invocation — we allow exactly one.
  let alreadyRendered = false;

  const boundRenderVisual = createTool({
    description: `Save a generated visual frame. Call EXACTLY ONCE per sub-agent run. Further calls are rejected.`,
    inputSchema: z.object({
      skill: z.enum(["manim", "diagram", "ui", "particles"]),
      config: z.string().describe("JSON config for the renderer"),
      narration: z.string().describe("Voice narration for this frame"),
      step: z.number().optional().describe("Step number"),
    }),
    execute: async (ctx, args): Promise<string> => {
      if (alreadyRendered) {
        return `REJECTED: renderVisual already called for step ${step}. Do not call again. Stop and exit.`;
      }
      alreadyRendered = true;

      const explanationId = await ctx.runMutation(internal.explanations.create, {
        threadId: parentThreadId,
        messageId: ctx.messageId,
        skill: args.skill,
        config: args.config,
        narration: args.narration,
        step: args.step ?? step,
        userId,
      });

      if (args.narration) {
        await ctx.scheduler.runAfter(0, internal.tts.generateAudio, {
          narration: args.narration,
          explanationId,
        });
      }

      return `Saved frame ${args.step ?? step} (${args.skill}). Your task is complete. STOP.`;
    },
  });

  return new Agent(components.agent, {
    name: `sub-agent-step-${step}`,
    languageModel: groq(modelName),
    instructions: SUB_AGENT_INSTRUCTIONS,
    tools: { invokeSkill, renderVisual: boundRenderVisual },
    // 3 is enough: (1) invokeSkill, (2) renderVisual, (3) optional noop.
    maxSteps: 3,
  });
}
