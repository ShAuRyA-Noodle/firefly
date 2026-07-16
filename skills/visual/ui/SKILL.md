---
name: visual/ui
description: Use for the mandatory final summary frame with ActionCards for follow-ups. Also use when a frame is fundamentally a comparison-as-cards, a quiz, or structured tabular data that reads better than animation.
domains: ["data", "comparison", "quiz", "exploration", "interactive"]
---

# UI Skill — Interactive Components

Generate json-render component trees for interactive, structured visual content.

## Structured plan (prelude — fill out before writing the tree)

Before producing the JsonNode tree, mentally answer:
1. Is this the final summary frame (the director's last frame REQUIRES skill="ui" with ActionCards)? If yes, plan 3-4 ActionCards covering distinct follow-up angles.
2. If it is a non-summary ui frame: what concrete piece of structured information does the user need that animation cannot deliver?
3. What is the layout: Stack, Grid, or single Card?
4. What plain-English sentence will appear in `narrativeSummary` (1-2 sentences, ≤400 chars, what the viewer learns)?

Then write the tree. The structured plan is not output — it prevents the trap of using ui as a generic dumping ground when manim or diagram would carry the idea better.

## Output Format

Call `renderVisual` with skill "ui" and config as a JSON string:

```json
{
  "component": "Stack",
  "props": { "gap": 4 },
  "children": [
    {
      "component": "Heading",
      "props": { "level": 2 },
      "children": "Newton's Laws of Motion"
    },
    {
      "component": "Grid",
      "props": { "columns": 3, "gap": 4 },
      "children": [
        {
          "component": "Card",
          "props": { "variant": "outlined" },
          "children": [
            { "component": "Heading", "props": { "level": 3 }, "children": "1st Law" },
            { "component": "Text", "children": "An object at rest stays at rest" },
            { "component": "Badge", "props": { "variant": "blue" }, "children": "Inertia" }
          ]
        },
        {
          "component": "Card",
          "props": { "variant": "outlined" },
          "children": [
            { "component": "Heading", "props": { "level": 3 }, "children": "2nd Law" },
            { "component": "Text", "children": "F = ma" },
            { "component": "Badge", "props": { "variant": "green" }, "children": "Force" }
          ]
        },
        {
          "component": "Card",
          "props": { "variant": "outlined" },
          "children": [
            { "component": "Heading", "props": { "level": 3 }, "children": "3rd Law" },
            { "component": "Text", "children": "Every action has an equal and opposite reaction" },
            { "component": "Badge", "props": { "variant": "red" }, "children": "Pairs" }
          ]
        }
      ]
    }
  ]
}
```

## Available Components

### Layout
- `Stack`: Vertical stack. Props: `gap`, `align`
- `Grid`: Grid layout. Props: `columns`, `gap`
- `Flex`: Flexbox. Props: `direction`, `gap`, `justify`, `align`

### Content
- `Heading`: h1-h6. Props: `level`
- `Text`: Paragraph text. Props: `size`, `color`, `weight`
- `Badge`: Small label. Props: `variant` (blue/green/red/yellow/gray)
- `Code`: Code block. Props: `language`

### Data
- `Card`: Container with border. Props: `variant` (outlined/filled/elevated)
- `Table`: Data table. Props: `headers` (string[]), `rows` (string[][])
- `List`: Bullet/number list. Props: `ordered`, `items` (string[])
- `Progress`: Progress bar. Props: `value` (0-100), `label`

### Interactive
- `Tabs`: Tabbed content. Props: `tabs` (array of {label, content})
- `Accordion`: Expandable sections. Props: `items` (array of {title, content})
- `Alert`: Info/warning/error box. Props: `variant`, `title`, `message`

### Actions (IMPORTANT — use these for navigation)
- `ActionCard`: Clickable option that sends a prompt to the AI. Props: `prompt` (the message to send when clicked), `icon` (emoji), `variant` (default/primary/subtle). The children text is what the user sees.

Example ActionCard usage:
```json
{
  "component": "ActionCard",
  "props": { "prompt": "Quiz me on photosynthesis", "icon": "🧪" },
  "children": "Quiz me on this"
}
```

### Quiz components
- `QuizMCQ`: Multiple-choice question. Props: `question` (string), `options` (string[], 3-5 entries, exactly one correct), `concept` (short string — the concept being tested, used for spaced repetition), `questionIndex` (0-based, only needed when multiple quizzes share a frame).
- `QuizFill`: Fill-in-the-blank. Props: `question`, `hint` (optional, short), `concept`, `questionIndex`.

Example QuizMCQ:
```json
{
  "component": "QuizMCQ",
  "props": {
    "question": "What does the chain rule give you?",
    "options": [
      "The derivative of a composition of functions",
      "The integral of a sum",
      "The slope at a single point",
      "The area under a curve"
    ],
    "correctAnswer": "The derivative of a composition of functions",
    "concept": "chain rule"
  }
}
```

The `correctAnswer` field MUST be present on every Quiz node in the config you generate — the server reads it from the persisted config to score answers. Clients no longer pass it back. Failure to include `correctAnswer` in config makes the quiz un-scorable. For `QuizMCQ`, `correctAnswer` must equal one of the `options` strings exactly (whitespace and case are normalized server-side, but be precise). For `QuizFill`, `correctAnswer` is the canonical answer string and the server applies whitespace/case-tolerant matching.

Quiz UX rules:
- Quiz frames should contain at most ONE Quiz component per frame so the user focuses.
- The `correctAnswer` MUST match one option in `QuizMCQ` exactly (case-sensitive comparison happens client-side, but normalize whitespace).
- Always set `concept` — quiz answers update the user's concept-mastery counter when correct.
- Wrong answers do NOT punish the user, but they don't bump mastery either; phrase questions for genuine learning, not gotchas.

## Quality Rules

1. Always use a Stack as the root element
2. Use Grid for comparing 2-4 items side by side
3. Keep text minimal — this is supposed to REPLACE text with structure
4. Use Badges and color coding for quick scanning
5. Use Tabs for multiple facets of the same concept
6. Prefer cards over paragraphs for chunked information
7. ALWAYS end explanations with a final renderVisual call containing 3-5 ActionCards as next steps. This is the primary way users navigate — text input is secondary. Include options like: quiz me, go deeper, show example, explain related concept.
8. Headings must be ≤ 60 characters. If the topic title is longer, split it into a short `Heading` plus a `Text` subtitle below.
9. Use `Grid` with `columns: 3` only when each card body is ≤ 80 characters. For longer card bodies use `columns: 2`, or drop the Grid and stack the cards in a `Stack`.
10. Never put multi-line, formula-like, or code-like text inside a Grid cell — use a full-width `Card` inside a `Stack` instead. Long unbroken tokens (e.g. `R̂_n(F)`) will overflow narrow grid cells.

## Anti-slop rules (forbidden patterns)

These rules prevent the "AI tells" that make outputs feel synthetic. Adapted
from the taste-skill / redesign-skill conventions, scoped to our renderer.

11. **Forbidden placeholders:** never use "John Doe", "Jane Smith", "Lorem ipsum", "$99.99", "1234567890", "example.com", or any other placeholder name/number/email. If you need a sample value, pick a real-feeling one ("Maria Chen", "$47", "kepler-186f@nasa.gov" if a domain example, etc.).
12. **Forbidden marketing slop copy:** no "Unleash", "Seamless", "Revolutionary", "Game-changing", "Empower", "Cutting-edge", "Robust", "Industry-leading". Educational content states facts — it does not sell.
13. **Forbidden 3-equal-card hero:** the `1st Law / 2nd Law / 3rd Law` example in this file is fine for an actual 3-of-a-kind list. Don't copy that shape when the underlying content is one main idea + two filler cards. Stack a single Card with the real content instead.
14. **Forbidden emoji-as-icon when a Badge variant exists:** if you would label a card "good" / "bad" / "warning", use `Badge` with the right `variant` (green/red/yellow), not emoji. Emoji is OK on `ActionCard.icon` because that's the explicit affordance for it.
15. **Forbidden centered-hero stack with no surrounding content:** `Stack` with one centered `Heading` and nothing else is a marketing landing-page tell. The render frame is for *answers*, not landing pages.

## States rule

16. Data components (`Table`, `Progress`, `List`) MUST handle the empty case. If the data array is empty, emit an `Alert` with `variant="info"` saying so, NOT an empty table or 0% progress bar — those read as bugs to the user. Example: `{component: "Alert", props: {variant: "info", title: "No data yet", message: "..."}}` instead of `{component: "Table", props: {headers: [...], rows: []}}`.

## Density dial (optional hint)

17. Vary visual density across frames — back-to-back high-density grids feel like a textbook. Mentally pick one of `airy` (Stack with `gap: 6`, no Grid), `standard` (Stack/Grid mix, `gap: 4`), or `dense` (Grid `columns: 3`, `gap: 3`) for each frame and apply consistently within that frame. Skill credit: taste-skill (MIT, Leonxlnx 2026).

## Optional: `narrativeSummary`

You MAY include a top-level `narrativeSummary` field on the root JsonNode (sibling to `component`/`props`/`children`) — a 1-2 sentence plain-English description of what this frame conveys (≤400 chars). Example: `"narrativeSummary": "Compares three sorting algorithms across time complexity, space, and stability."`. The renderer ignores it; it is a readable hedge for search and share-page text mode.
