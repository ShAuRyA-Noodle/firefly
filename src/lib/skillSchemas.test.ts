import { describe, test, expect } from "vitest";
import {
  validateSkillConfig,
  parseAndValidateSkillConfig,
} from "../../convex/lib/skillSchemas";

describe("validateSkillConfig — manim", () => {
  test("accepts a minimal scene with one object and one animation", () => {
    const result = validateSkillConfig("manim", {
      scenes: [
        {
          objects: [{ type: "circle", id: "c1", radius: 1, color: "#fff" }],
          animations: [{ type: "create", targetId: "c1", duration: 1 }],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts passthrough object props the factory knows about", () => {
    const result = validateSkillConfig("manim", {
      scenes: [
        {
          objects: [{ type: "function_graph", id: "g", fn: "x*x" }],
          animations: [{ type: "create", targetId: "g" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects unknown object type", () => {
    const result = validateSkillConfig("manim", {
      scenes: [
        {
          objects: [{ type: "hypercube", id: "h" }],
          animations: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/hypercube|invalid|enum/i);
  });

  test("rejects empty scenes array", () => {
    const result = validateSkillConfig("manim", { scenes: [] });
    expect(result.ok).toBe(false);
  });

  test("rejects object missing id", () => {
    const result = validateSkillConfig("manim", {
      scenes: [
        { objects: [{ type: "circle" }], animations: [] },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects unknown animation type", () => {
    const result = validateSkillConfig("manim", {
      scenes: [
        {
          objects: [{ type: "circle", id: "c" }],
          animations: [{ type: "teleport", targetId: "c" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateSkillConfig — diagram", () => {
  test("accepts minimal Excalidraw element shape", () => {
    const result = validateSkillConfig("diagram", {
      elements: [
        { type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects empty elements array", () => {
    const result = validateSkillConfig("diagram", { elements: [] });
    expect(result.ok).toBe(false);
  });

  test("rejects element missing required coordinates", () => {
    const result = validateSkillConfig("diagram", {
      elements: [{ type: "rectangle" }],
    });
    expect(result.ok).toBe(false);
  });

  test("passthrough: accepts unknown Excalidraw element properties", () => {
    const result = validateSkillConfig("diagram", {
      elements: [
        {
          type: "arrow",
          x: 0,
          y: 0,
          points: [[0, 0], [100, 100]],
          strokeColor: "#fff",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeStyle: "solid",
          roughness: 1,
          opacity: 100,
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateSkillConfig — ui", () => {
  test("accepts a simple JsonNode", () => {
    const result = validateSkillConfig("ui", {
      component: "Stack",
      children: [
        { component: "Heading", children: "Hello" },
        { component: "Text", children: "Body" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts string children", () => {
    const result = validateSkillConfig("ui", {
      component: "Text",
      children: "hello",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts ActionCard with prompt", () => {
    const result = validateSkillConfig("ui", {
      component: "ActionCard",
      props: { prompt: "explain chain rule" },
      children: "Chain rule",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects node missing component name", () => {
    const result = validateSkillConfig("ui", { children: "orphan" });
    expect(result.ok).toBe(false);
  });

  test("recurses deeply into children", () => {
    const result = validateSkillConfig("ui", {
      component: "Stack",
      children: [
        {
          component: "Card",
          children: [
            {
              component: "Grid",
              children: [
                { component: "Badge", children: "A" },
                { component: "Badge", children: "B" },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateSkillConfig — particles", () => {
  const baseConfig = () => ({
    particleCount: 1000,
    bounds: { x: [-5, 5], y: [-5, 5], z: [-5, 5] },
    camera: { position: [0, 0, 10], lookAt: [0, 0, 0] },
    forces: [],
    appearance: {
      colorMode: "velocity" as const,
      colorMap: ["#fff", "#f00"],
      size: 2,
      opacity: 0.8,
    },
    physics: { damping: 0.98, maxVelocity: 10 },
  });

  test("accepts a complete config with no forces", () => {
    const result = validateSkillConfig("particles", baseConfig());
    expect(result.ok).toBe(true);
  });

  test("accepts all force variants via discriminated union", () => {
    const result = validateSkillConfig("particles", {
      ...baseConfig(),
      forces: [
        {
          type: "attractor",
          position: [0, 0, 0],
          strength: 1,
          falloff: "inverse_square",
        },
        { type: "noise", scale: 0.5, strength: 1, speed: 1 },
        { type: "gravity", direction: [0, -1, 0], strength: 9.8 },
        { type: "boundary", shape: "sphere", radius: 5 },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects invalid falloff enum", () => {
    const result = validateSkillConfig("particles", {
      ...baseConfig(),
      forces: [
        {
          type: "attractor",
          position: [0, 0, 0],
          strength: 1,
          falloff: "cubic",
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative particle count", () => {
    const result = validateSkillConfig("particles", {
      ...baseConfig(),
      particleCount: -5,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects opacity outside [0, 1]", () => {
    const cfg = baseConfig();
    cfg.appearance.opacity = 2;
    const result = validateSkillConfig("particles", cfg);
    expect(result.ok).toBe(false);
  });
});

describe("validateSkillConfig — code", () => {
  test("accepts a minimal valid config with 2 steps", () => {
    const result = validateSkillConfig("code", {
      language: "python",
      code: "def f():\n    return 1",
      steps: [
        { lines: [1], label: "the function" },
        { lines: [2], label: "returns 1" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects steps that reference out-of-range lines", () => {
    const result = validateSkillConfig("code", {
      language: "python",
      code: "def f():\n    return 1",
      steps: [
        { lines: [1], label: "ok" },
        { lines: [99], label: "not ok" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/out of range/i);
  });

  test("rejects unsupported language", () => {
    const result = validateSkillConfig("code", {
      language: "cobol",
      code: "x",
      steps: [
        { lines: [1], label: "a" },
        { lines: [1], label: "b" },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects fewer than 2 steps", () => {
    const result = validateSkillConfig("code", {
      language: "python",
      code: "x = 1",
      steps: [{ lines: [1], label: "lonely" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateSkillConfig — dispatch", () => {
  test("rejects unknown skill name with a clear message", () => {
    const result = validateSkillConfig("hologram", { anything: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown skill/i);
  });
});

describe("parseAndValidateSkillConfig", () => {
  test("accepts valid JSON string", () => {
    const result = parseAndValidateSkillConfig(
      "ui",
      JSON.stringify({ component: "Text", children: "hi" }),
    );
    expect(result.ok).toBe(true);
  });

  test("reports JSON parse failures distinctly from schema errors", () => {
    const result = parseAndValidateSkillConfig("ui", "{ not: json ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not valid json/i);
  });

  test("reports schema errors for well-formed but invalid JSON", () => {
    const result = parseAndValidateSkillConfig(
      "manim",
      JSON.stringify({ scenes: "nope" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toMatch(/not valid json/i);
  });
});
