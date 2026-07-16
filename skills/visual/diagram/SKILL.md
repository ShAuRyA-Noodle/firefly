---
name: visual/diagram
description: Use when explaining concept maps, flowcharts, system architecture, processes with steps, comparisons of ≥3 things, or relationships between components. Best when the answer has STRUCTURE.
domains: ["systems", "architecture", "concepts", "processes", "relationships"]
---

# Diagram Skill — Excalidraw

Generate an array of **skeleton** Excalidraw elements. The renderer runs them
through Excalidraw's `convertToExcalidrawElements`, which fills in all the
low-level fields (seed, version, bindings, defaults) for you. **Emit only the
minimal fields below — do NOT hand-write `seed`, `versionNonce`, `version`,
`isDeleted`, `groupIds`, `boundElements`, or `containerId`.** Getting those
wrong is the #1 cause of a blank diagram.

## Structured plan (prelude — fill out before writing elements)

Before producing the element list, mentally answer:
1. What are the 3-7 nodes (boxes/shapes) in this diagram, and what does each represent?
2. What edges (arrows) connect them, and what does each connection mean?
3. What is the layout: top-down flow, left-right pipeline, or hub-and-spoke?
4. What plain-English sentence will appear in `narrativeSummary` (1-2 sentences, ≤400 chars)?

## Output Format

Call `renderVisual` with skill "diagram" and config as a JSON string containing
an `elements` array:

```json
{
  "elements": [
    {
      "type": "text",
      "x": 300,
      "y": 40,
      "text": "Neural Network",
      "fontSize": 28,
      "strokeColor": "#1e1e1e"
    },
    {
      "id": "input",
      "type": "rectangle",
      "x": 260,
      "y": 120,
      "width": 200,
      "height": 70,
      "backgroundColor": "#a5d8ff",
      "strokeColor": "#1971c2",
      "label": { "text": "Input Layer", "strokeColor": "#1e1e1e" }
    },
    {
      "id": "hidden",
      "type": "rectangle",
      "x": 260,
      "y": 260,
      "width": 200,
      "height": 70,
      "backgroundColor": "#b2f2bb",
      "strokeColor": "#2f9e44",
      "label": { "text": "Hidden Layer" }
    },
    {
      "id": "output",
      "type": "rectangle",
      "x": 260,
      "y": 400,
      "width": 200,
      "height": 70,
      "backgroundColor": "#ffc9c9",
      "strokeColor": "#c92a2a",
      "label": { "text": "Output Layer" }
    },
    { "type": "arrow", "x": 360, "y": 190, "start": { "id": "input" }, "end": { "id": "hidden" } },
    { "type": "arrow", "x": 360, "y": 330, "start": { "id": "hidden" }, "end": { "id": "output" } }
  ]
}
```

## Element Types + the ONLY fields you write

**text** (standalone label / title):
- `type: "text"`, `x`, `y`, `text`, and optionally `fontSize` (14-28), `strokeColor`.

**rectangle / ellipse / diamond** (a node):
- `type`, `x`, `y`, `width`, `height`.
- `id`: a unique string — REQUIRED if an arrow connects to this node.
- `label`: `{ "text": "…" }` to place centered text inside the shape (optionally `strokeColor`, `fontSize`). Prefer this over a separate text element.
- Optional style: `backgroundColor`, `strokeColor`, `fillStyle` ("solid" | "hachure" | "cross-hatch"), `strokeWidth` (1-4), `roughness` (0 clean, 1 hand-drawn).

**arrow / line** (an edge):
- `type`, `x`, `y`.
- To connect two nodes, give `start: { "id": "<nodeId>" }` and `end: { "id": "<nodeId>" }` — the arrow auto-binds and reflows. This is strongly preferred.
- Or give explicit geometry: `width`, `height`, `points` (array of `[x,y]` offsets, e.g. `[[0,0],[0,100]]`).
- Optional `label: { "text": "…" }` to caption the edge.

## Color Palette

**The canvas is light (warm paper). ALL text MUST be dark or it is invisible.**
Never use white/near-white text (`#ffffff`, `#e8e4dd`) — it disappears.

- Text (titles, labels, captions): `#1e1e1e` — the default. Always dark.
- Blue: `#a5d8ff` bg / `#1971c2` stroke
- Green: `#b2f2bb` bg / `#2f9e44` stroke
- Red: `#ffc9c9` bg / `#c92a2a` stroke
- Yellow: `#fff3bf` bg / `#e67700` stroke
- Gray: `#dee2e6` bg / `#495057` stroke

Labels inside pastel-filled shapes also read best in `#1e1e1e`.

## Quality Rules

1. Always start with a `text` title (fontSize 24-28) at the top, at `y: 40`.
2. **Put every caption in a node's `label` — NEVER as a separate free-floating
   `text` element placed near a shape.** Free text reserves no space, so several
   labels pile onto the same pixels and become an unreadable blob. The ONLY free
   `text` elements allowed are the title and short edge captions.
3. Connect nodes with `start`/`end` id bindings, not hand-computed points — arrows then reflow cleanly.
4. Give every node that an arrow touches a unique `id`.

### LAYOUT GRID — obey exactly (this is what prevents overlap)

**Never place two elements on overlapping coordinates.** Snap every node to this
grid; each node owns its own cell:

- Column `x` values: `80`, `420`, `760`, `1100`
- Row `y` values: `140`, `300`, `460`, `620`
- Node size: `width: 240`, `height: 110` (grow only if the label needs it)

That leaves ≥100px horizontal and ≥50px vertical clearance between nodes. Two
nodes MUST NOT share the same (x, y). Flow left→right across columns, or
top→down across rows. Keep it to 3-7 nodes, ≤ 20 elements total.

If a concept has sub-parts (e.g. "Camera 12MP", "LED", "Button"), do NOT scatter
them as text around one shape — either give each its own grid cell, or fold them
into that one node's label as a short multi-line string.

## Optional: `narrativeSummary`

You MAY include a top-level `narrativeSummary` field (sibling to `elements`) —
a 1-2 sentence plain-English description of what this frame conveys (≤400 chars).
The renderer ignores it; it's a readable hedge for search and share-page text mode.
