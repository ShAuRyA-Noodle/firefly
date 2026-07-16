---
name: visual/code
description: Use when explaining algorithms, data-structure operations, language constructs, or line-by-line walkthroughs of small (<30 line) code samples. Required when the answer is fundamentally about code that should be read.
domains: ["code", "algorithm", "programming", "walkthrough", "debugging"]
---

# Code Skill — Step-through Code Visualization

Generate a code sample plus an ordered list of "step" instructions that highlight specific lines while you narrate. The renderer uses Shiki for real syntax highlighting and animates a crimson highlight bar through the steps.

## Structured plan (prelude — fill out before writing config)

Before producing the config, mentally answer:
1. What single algorithm or pattern does this snippet teach?
2. What is the smallest self-contained snippet (<30 lines) that demonstrates it?
3. What 3-5 step labels walk a reader through the snippet's logic?
4. What plain-English sentence will appear in `narrativeSummary` (1-2 sentences, ≤400 chars, what the viewer learns)?

Then write the config. The structured plan is not output — it prevents pasting full files when a 12-line excerpt would teach the same idea.

## Output Format

Call `renderVisual` with skill `"code"` and config as a JSON string:

```json
{
  "language": "python",
  "code": "def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)",
  "title": "Recursive Fibonacci",
  "steps": [
    { "lines": [1], "label": "the function takes an integer n" },
    { "lines": [2, 3], "label": "base case: 0 → 0, 1 → 1" },
    { "lines": [4], "label": "recursive case sums the two prior fib numbers" }
  ]
}
```

## Required fields

- `language` (string) — Shiki language id. Use one of: `typescript`, `javascript`, `python`, `rust`, `go`, `java`, `c`, `cpp`, `csharp`, `swift`, `kotlin`, `ruby`, `php`, `sql`, `bash`, `shell`, `json`, `yaml`, `html`, `css`, `markdown`. If unsure, use `text`.
- `code` (string) — the source. Keep it ≤ 30 lines. Use `\n` for newlines in the JSON string.
- `steps` (array, 2-8 items) — each step is `{ lines: number[], label: string }`. Lines are 1-indexed and refer to the `code` source. The renderer dims everything outside the active step's lines.

## Optional fields

- `title` (string, ≤ 60 chars) — shown above the code.
- `caption` (string, ≤ 200 chars) — single line below the code.

## Quality rules

1. Code must be self-contained and runnable in concept — no missing imports inferred from "..." ellipses.
2. Each step's `lines` must be valid 1-indexed line numbers within `code`.
3. Step labels are ONE clause, ≤ 80 chars, present tense ("the loop iterates over each item").
4. 3-5 steps is the sweet spot. Fewer than 2 makes the walkthrough pointless; more than 8 overwhelms.
5. Prefer `python` for pseudo-code if the topic is language-agnostic — it reads cleanest.
6. Never paste massive frameworks or full files. If the answer needs more than ~30 lines, summarize the structure and show one focused snippet.

## Optional: `narrativeSummary`

You MAY include a top-level `narrativeSummary` field on the config object — a 1-2 sentence plain-English description of what this frame conveys (≤400 chars). Example: `"narrativeSummary": "Walks through a recursive Fibonacci implementation: base case at n<2, recursive sum of fib(n-1) and fib(n-2)."`. The renderer ignores it; it is a readable hedge for search and share-page text mode.
