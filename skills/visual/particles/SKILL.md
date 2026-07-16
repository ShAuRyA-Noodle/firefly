---
name: visual/particles
description: Use when explaining physics forces, waves, fields, or molecular/atomic behavior. Best for emergence-style topics where motion communicates the concept.
domains: ["physics", "simulation", "forces", "waves", "fields", "molecular"]
---

# Particles Skill — 3D Particle Simulations

Generate particle simulation configs that render as real-time 3D visualizations using React Three Fiber.

## Structured plan (prelude — fill out before writing config)

Before producing the config, mentally answer:
1. What physical phenomenon is this frame illustrating (gravity, fluid, vortex, charge field)?
2. Which forces produce that phenomenon, and at what strengths?
3. What camera angle reads the motion most clearly?
4. What plain-English sentence will appear in `narrativeSummary` (1-2 sentences, ≤400 chars, what the viewer learns)?

Then write the config. The structured plan is not output — it prevents random force soup that produces noise.

## Output Format

Call `renderVisual` with skill "particles" and config as a JSON string:

```json
{
  "particleCount": 5000,
  "bounds": { "x": [-10, 10], "y": [-10, 10], "z": [-10, 10] },
  "camera": { "position": [0, 5, 15], "lookAt": [0, 0, 0] },
  "forces": [
    {
      "type": "attractor",
      "position": [0, 0, 0],
      "strength": 5.0,
      "falloff": "inverse_square"
    },
    {
      "type": "noise",
      "scale": 0.5,
      "strength": 1.0
    }
  ],
  "appearance": {
    "colorMode": "velocity",
    "colorMap": ["#3b82f6", "#8b5cf6", "#ef4444"],
    "size": 0.05,
    "opacity": 0.8
  },
  "physics": {
    "damping": 0.98,
    "maxVelocity": 2.0
  }
}
```

## Force Types

- `attractor`: Pull toward point. Props: `position`, `strength`, `falloff` (linear/inverse_square/constant)
- `repulsor`: Push away from point. Same props as attractor
- `vortex`: Spiral around axis. Props: `axis` ([0,1,0]), `strength`, `position`
- `noise`: Perlin noise field. Props: `scale`, `strength`, `speed` (optional, default 1)
- `gravity`: Uniform direction. Props: `direction` ([0,-1,0]), `strength`
- `spring`: Attract to origin. Props: `stiffness`, `origin`
- `boundary`: Keep particles in bounds. Props: `shape` (sphere/box), `radius`

## Color Modes

- `velocity`: Color by speed (slow→fast maps to colorMap)
- `position`: Color by spatial position
- `age`: Color by particle lifetime
- `uniform`: Single color for all particles
- `gradient`: Gradient based on Y position

## Quality Rules

1. Start with 2000-5000 particles (balance visual impact vs. performance)
2. Always include a boundary force to keep particles in view
3. Use velocity-based coloring by default — it's the most informative
4. Include damping (0.95-0.99) to prevent chaos
5. Set camera position to show the most interesting angle
6. For gravity simulations, use fewer particles (1000-2000) with larger size

## Optional: `narrativeSummary`

You MAY include a top-level `narrativeSummary` field on the config object — a 1-2 sentence plain-English description of what this frame conveys (≤400 chars). Example: `"narrativeSummary": "A point attractor pulls 5000 particles inward; damping prevents orbital chaos and produces a stable disc."`. The renderer ignores it; it is a readable hedge for search and share-page text mode.
