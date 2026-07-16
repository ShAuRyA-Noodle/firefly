/// <reference types="vite/client" />
import { describe, test, expect } from "vitest";
import { validateSkillConfig } from "./skillSchemas";

/**
 * Guardrail: every construct the SKILL.md specs instruct the model to emit
 * MUST pass its schema. A spec that documents a type the schema rejects
 * silently burns the sub-agent's one retry and lands a _failed frame — the
 * exact "excalidraw / animations don't load" failure. These tests lock the
 * spec↔schema contract so drift is caught in CI, not in production renders.
 */

describe("skill spec examples validate against their schema", () => {
  test("manim: the full object + animation vocabulary the spec documents", () => {
    const config = {
      scenes: [
        {
          id: "s1",
          title: "vocab",
          objects: [
            { type: "function_graph", id: "g", fn: "x*x", xRange: [-3, 3] },
            { type: "line", id: "l", start: [-1, 1], end: [1, 3] },
            { type: "arrow", id: "a", start: [0, 0], end: [1, 1] },
            { type: "text", id: "t", content: "f(x)", position: [2, 4] },
            { type: "latex", id: "f", expression: "2x", position: [0, -3.5] },
            { type: "point", id: "p", position: [1, 1] },
            // Documented in manim/SKILL.md but historically rejected:
            { type: "vector", id: "v", origin: [0, 0], direction: [1, 1] },
            {
              type: "number_line",
              id: "n",
              range: [-5, 5],
              tickInterval: 1,
            },
            { type: "coordinate_system", id: "cs", xRange: [-5, 5] },
          ],
          animations: [
            { type: "create", targetId: "g", duration: 1.5 },
            { type: "fadeIn", targetId: "t", duration: 0.5 },
            { type: "transform", targetId: "l", to: { end: [2, 4] } },
            // Documented in manim/SKILL.md but historically rejected:
            { type: "moveTo", targetId: "v", to: { position: [2, 2] } },
            { type: "indicate", targetId: "f" },
            { type: "wait", duration: 1 },
          ],
        },
      ],
    };
    const res = validateSkillConfig("manim", config);
    expect(res.ok).toBe(true);
  });

  test("particles: the noise force from the spec example (no explicit speed)", () => {
    const config = {
      particleCount: 5000,
      bounds: { x: [-10, 10], y: [-10, 10], z: [-10, 10] },
      camera: { position: [0, 5, 15], lookAt: [0, 0, 0] },
      forces: [
        {
          type: "attractor",
          position: [0, 0, 0],
          strength: 5.0,
          falloff: "inverse_square",
        },
        // Exactly the spec's worked example — omits `speed`.
        { type: "noise", scale: 0.5, strength: 1.0 },
      ],
      appearance: {
        colorMode: "velocity",
        colorMap: ["#3b82f6", "#8b5cf6", "#ef4444"],
        size: 0.05,
        opacity: 0.8,
      },
      physics: { damping: 0.98, maxVelocity: 2.0 },
    };
    const res = validateSkillConfig("particles", config);
    expect(res.ok).toBe(true);
    // The default must be materialized so the renderer never sees NaN speed.
    if (res.ok) {
      const noise = (res.data as { forces: Array<{ type: string; speed?: number }> })
        .forces.find((f) => f.type === "noise");
      expect(typeof noise?.speed).toBe("number");
    }
  });

  test("diagram: a minimal skeleton element list validates", () => {
    const config = {
      elements: [
        { type: "rectangle", x: 100, y: 100, width: 200, height: 80 },
        { type: "text", x: 140, y: 130, text: "Input" },
        { type: "arrow", x: 200, y: 180, width: 0, height: 70 },
      ],
    };
    const res = validateSkillConfig("diagram", config);
    expect(res.ok).toBe(true);
  });
});
