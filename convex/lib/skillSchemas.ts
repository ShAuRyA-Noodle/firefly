/**
 * Zod schemas for every agent-generated skill config.
 *
 * Used in two places:
 *   1. Server-side in the sub-agent's renderVisual tool — reject malformed
 *      JSON BEFORE it is written to the explanations table, and return a
 *      retry-friendly error message the model can correct from.
 *   2. Client-side in SkillRouter as defense-in-depth — render a clear
 *      "frame malformed" panel instead of crashing a renderer.
 *
 * Keep this file runtime-neutral: no Convex types, no React, no Node APIs.
 */

import { z } from "zod";

export type SkillName = "manim" | "diagram" | "ui" | "particles" | "code";

// ─── Shared primitives ────────────────────────────────────────────────────

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const range = z.tuple([z.number(), z.number()]);

// [lambda] Optional 1-2 sentence plain-English summary of what the frame
// conveys. Backward-compat: every consumer treats this as optional, so
// rows already in the explanations table without it remain valid. NOT
// used by the TTS pipeline (narration is a separate field). Hedge for
// downstream readers: search index, share-page text-only mode, future
// RAG over a user's frame history.
const narrativeSummary = z.string().max(400).optional();

// ─── Manim ────────────────────────────────────────────────────────────────

const MANIM_OBJECT_TYPES = [
  "function_graph",
  "circle",
  "rectangle",
  "square",
  "line",
  "arrow",
  "point",
  "dot",
  "text",
  "latex",
  // `vector` (origin+direction arrow) and `number_line` (1D axis) are
  // documented in manim/SKILL.md; they MUST be accepted here or a spec-
  // following config is rejected and lands a _failed frame. The renderer
  // maps vector→Arrow and number_line→Axes.
  "vector",
  "number_line",
  "coordinate_system",
  "axes",
] as const;

const MANIM_ANIMATION_TYPES = [
  "create",
  "write",
  "fadeIn",
  "fadeOut",
  "transform",
  // Documented in manim/SKILL.md. The renderer animates `moveTo` to a
  // position and falls back to a highlight for `indicate`; both must pass
  // schema validation to ever reach the renderer.
  "moveTo",
  "indicate",
  "wait",
] as const;

const manimObject = z
  .object({
    type: z.enum(MANIM_OBJECT_TYPES),
    id: z.string().min(1),
    // All shape-specific props are permissive passthrough; the renderer factory
    // applies its own defaults per type. Rejecting unknown props here would
    // force brittle symmetry with the factory.
  })
  .passthrough();

const manimAnimation = z
  .object({
    type: z.enum(MANIM_ANIMATION_TYPES),
    targetId: z.string().optional(),
    duration: z.number().positive().max(60).optional(),
    to: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const manimScene = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  objects: z.array(manimObject).max(64),
  animations: z.array(manimAnimation).max(64),
});

export const manimConfigSchema = z.object({
  scenes: z.array(manimScene).min(1).max(4),
  narrativeSummary, // [lambda] dual-observation hedge — see top of file
});

// ─── Diagram (Excalidraw) ─────────────────────────────────────────────────

// Excalidraw's full element schema is huge and version-specific — validating
// it rigidly would fight the library. We enforce the minimum set Excalidraw
// itself requires to render, then let it handle the rest.
const diagramElement = z
  .object({
    type: z.string().min(1),
    x: z.number(),
    y: z.number(),
  })
  .passthrough();

export const diagramConfigSchema = z.object({
  elements: z.array(diagramElement).min(1).max(256),
  narrativeSummary, // [lambda] dual-observation hedge — see top of file
});

// ─── UI (JsonNode tree) ───────────────────────────────────────────────────

export type JsonNode = {
  component: string;
  props?: Record<string, unknown>;
  children?: Array<JsonNode | string> | string;
};

export const jsonNodeSchema: z.ZodType<JsonNode> = z.lazy(() =>
  z.object({
    component: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    children: z
      .union([
        z.string(),
        z.array(z.union([jsonNodeSchema, z.string()])).max(256),
      ])
      .optional(),
  }),
);

// [lambda] ui's top-level config is a JsonNode that MAY carry an optional
// narrativeSummary as a sibling field. Backward-compat: existing rows
// without the field still validate (it's optional). The renderer only
// looks at component/props/children, so the extra field is purely a
// readable artifact.
export const uiConfigSchema = z.lazy(() =>
  z.object({
    component: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    children: z
      .union([
        z.string(),
        z.array(z.union([jsonNodeSchema, z.string()])).max(256),
      ])
      .optional(),
    narrativeSummary, // [lambda] dual-observation hedge — see top of file
  }),
);

// ─── Particles ────────────────────────────────────────────────────────────

const forceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attractor"),
    position: vec3,
    strength: z.number(),
    falloff: z.enum(["linear", "inverse_square", "constant"]),
  }),
  z.object({
    type: z.literal("repulsor"),
    position: vec3,
    strength: z.number(),
    falloff: z.enum(["linear", "inverse_square", "constant"]),
  }),
  z.object({
    type: z.literal("vortex"),
    axis: vec3,
    strength: z.number(),
    position: vec3,
  }),
  z.object({
    type: z.literal("noise"),
    scale: z.number().positive(),
    strength: z.number(),
    // The spec's worked example omits `speed`; default it so a copy of the
    // example validates and the renderer never integrates against NaN.
    speed: z.number().default(1),
  }),
  z.object({
    type: z.literal("gravity"),
    direction: vec3,
    strength: z.number(),
  }),
  z.object({
    type: z.literal("spring"),
    stiffness: z.number(),
    origin: vec3,
  }),
  z.object({
    type: z.literal("boundary"),
    shape: z.enum(["sphere", "box"]),
    radius: z.number().positive(),
  }),
]);

const appearanceSchema = z.object({
  colorMode: z.enum(["velocity", "position", "age", "uniform", "gradient"]),
  colorMap: z.array(z.string()).min(1).max(16),
  size: z.number().positive().max(10),
  opacity: z.number().min(0).max(1),
});

const physicsSchema = z.object({
  damping: z.number().min(0).max(1),
  maxVelocity: z.number().positive().max(100),
});

export const particlesConfigSchema = z.object({
  particleCount: z.number().int().positive().max(50_000),
  bounds: z.object({ x: range, y: range, z: range }),
  camera: z.object({ position: vec3, lookAt: vec3 }),
  forces: z.array(forceSchema).max(16),
  appearance: appearanceSchema,
  physics: physicsSchema,
  narrativeSummary, // [lambda] dual-observation hedge — see top of file
});

// ─── Code (Shiki step-through) ────────────────────────────────────────────

const codeStepSchema = z.object({
  lines: z.array(z.number().int().positive()).min(1).max(64),
  label: z.string().min(1).max(160),
});

const SHIKI_LANGUAGES = [
  "text",
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "swift",
  "kotlin",
  "ruby",
  "php",
  "sql",
  "bash",
  "shell",
  "json",
  "yaml",
  "html",
  "css",
  "markdown",
] as const;

export const codeConfigSchema = z
  .object({
    language: z.enum(SHIKI_LANGUAGES),
    code: z.string().min(1).max(8000),
    title: z.string().max(120).optional(),
    caption: z.string().max(400).optional(),
    steps: z.array(codeStepSchema).min(2).max(12),
    narrativeSummary, // [lambda] dual-observation hedge — see top of file
  })
  .superRefine((cfg, ctx) => {
    const lineCount = cfg.code.split(/\r?\n/).length;
    for (let i = 0; i < cfg.steps.length; i++) {
      for (const ln of cfg.steps[i].lines) {
        if (ln > lineCount) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", i, "lines"],
            message: `line ${ln} is out of range (code has ${lineCount} lines)`,
          });
        }
      }
    }
  });

// ─── Dispatch ─────────────────────────────────────────────────────────────

const SCHEMAS = {
  manim: manimConfigSchema,
  diagram: diagramConfigSchema,
  ui: uiConfigSchema,
  particles: particlesConfigSchema,
  code: codeConfigSchema,
} as const;

export type SkillValidationResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Validate a parsed config object against the schema for `skill`.
 * Returns a result object — never throws. The error string is compact and
 * shaped for LLM feedback (first few problems, no stack).
 */
export function validateSkillConfig(
  skill: string,
  config: unknown,
): SkillValidationResult {
  const schema = (SCHEMAS as Record<string, z.ZodTypeAny>)[skill];
  if (!schema) {
    return { ok: false, error: `Unknown skill "${skill}"` };
  }
  const parsed = schema.safeParse(config);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: formatZodError(parsed.error) };
}

/**
 * Parse a JSON string config and validate it. Used server-side where the
 * agent hands us a string; the parse failure mode is distinct from the
 * schema failure mode and worth reporting precisely.
 */
export function parseAndValidateSkillConfig(
  skill: string,
  configJson: string,
): SkillValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(configJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `config is not valid JSON: ${msg}` };
  }
  return validateSkillConfig(skill, raw);
}

function formatZodError(err: z.ZodError): string {
  const issues = err.issues.slice(0, 5).map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  const more = err.issues.length > 5 ? ` (+${err.issues.length - 5} more)` : "";
  return issues.join("; ") + more;
}
