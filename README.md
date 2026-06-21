# firefly

**your questions, lit up inside.**

An AI tutor that answers with *visuals* instead of walls of text: math animations, particle simulations, system diagrams, and interactive cards, narrated by a talking avatar. Ask anything, watch it glow into existence frame by frame.

Built by [Shaurya Punj](https://github.com/ShAuRyA-Noodle) on a random Sunday afternoon in a cafe, because the itch to build wouldn't go away.

---

## The Problem

Text is a terrible way to learn. Humans don't think in paragraphs. We think in shapes, motion, space, and patterns. But every LLM on earth replies with another wall of words, and every textbook reads the same way for every student.

The best learners in history had *tutors*, not textbooks. Someone who adapted to *them*, challenged *their* thinking, and drew the idea out in the air. That model produces better thinkers. It just doesn't scale.

AI changes the economics. But most AI tutors just generate more text, the same broken medium. Firefly flips that: visuals are the default output, text is the exception.

---

## How It Works

You ask a question. The AI plans a visual narrative, then renders it frame by frame.

```
 "Explain derivatives"
         |
         v
  +--------------+
  | Director AI  |  Plans 3-4 narrative segments
  +--------------+
    |    |    |
    v    v    v
  +--+ +--+ +--+
  |S1| |S2| |S3|   Sub-agents render each frame
  +--+ +--+ +--+   independently and in parallel
    |    |    |
    v    v    v
  Manim  Manim  UI     Each picks the best medium:
  anim   anim   cards   math, diagram, particles, or UI
```

1. **Director Agent** takes the question and plans a narrative arc (core insight, deeper angle, contrast or application, summary with next actions)
2. **Visual Sub-Agents** each load a skill spec, generate structured JSON config, and save a frame
3. **Renderers** display each frame in real time as it arrives
4. **Avatar** narrates with Sarvam TTS, synced word by word
5. **ActionCards** let you branch into follow-up questions

The director never generates visuals itself. It orchestrates. The sub-agents never plan. They execute. Clean separation keeps each agent focused.

---

## Visual Skills

| Skill | Best For | Powered By |
|-------|----------|------------|
| **Manim** | Equations, graphs, geometry, step-by-step proofs | manim-web (3Blue1Brown style) |
| **Diagram** | Concept maps, flowcharts, architecture, relationships | Excalidraw |
| **Particles** | Physics forces, waves, fields, molecular behavior | React Three Fiber |
| **UI** | Summaries, comparisons, quizzes, next-step actions | Custom component renderer |

The AI picks the right medium per segment. A derivative explanation might use Manim for the math, then a UI card for the summary and follow-up prompts.

---

## Architecture

```
Browser (React + TanStack Start)
  |
  |-- TalkingHead         3D wireframe avatar (Three.js)
  |-- FrameContainer      Carousel of visual frames
  |-- SkillRouter         Routes to correct renderer
  |-- PromptInput         Text + speech input
  |
  v
Convex (Backend)
  |
  |-- Director Agent      Plans narrative, dispatches sub-agents
  |-- Visual Sub-Agents   Load skill specs, generate config JSON
  |-- TTS (Sarvam)        Async audio generation with word timings
  |-- Explanations DB     Stores frames, audio, timings per thread
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | TanStack Start + React 19 |
| Backend | Convex + @convex-dev/agent |
| AI | Groq via @ai-sdk/groq (gpt-oss-120b primary, Llama 3.3 70B fallback) |
| Voice | Sarvam AI TTS + Groq Whisper forced alignment for word-level timing |
| 3D Avatar | Custom R3F / Three.js humanoid rig with glow shaders |
| Math Animations | manim-web |
| Diagrams | Excalidraw |
| Particle Sims | React Three Fiber |
| Auth | Convex Auth (Password + Anonymous) |
| Rate Limiting | @convex-dev/rate-limiter |
| Styling | Tailwind CSS 4 |

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh)
- [Convex](https://convex.dev) account (free tier)
- [Groq](https://console.groq.com) API key (free tier)
- [Sarvam](https://dashboard.sarvam.ai) API key (free tier)

### Setup

```bash
git clone https://github.com/ShAuRyA-Noodle/firefly.git
cd firefly
bun install
```

Provision Convex, then set these in the Convex deployment environment:

```env
GROQ_API_KEY=gsk_...
GROQ_WHISPER_MODEL=whisper-large-v3
SARVAM_API_KEY=sk_...
SARVAM_TTS_MODEL=bulbul:v2
SARVAM_VOICE=anushka
SARVAM_LANGUAGE=en-IN
# Shared secret that authorizes the skills sync mutations.
# Generate a strong random value, for example: openssl rand -hex 32
SKILLS_SYNC_SECRET=<random-secret>
```

The skills sync mutations are public functions (the deployment URL ships in
the client bundle), so they require `SKILLS_SYNC_SECRET`. Set it in the Convex
deployment environment with `bunx convex env set SKILLS_SYNC_SECRET <value>`
and provide the same value to the sync script (see below).

The frontend needs one public variable in `.env.local`:

```env
VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
```

### Run

```bash
# One-time: provision Convex deployment and generate Auth keys
bunx convex dev            # pick "create new" and follow the browser sign-in
npx @convex-dev/auth       # generates JWT_PRIVATE_KEY + JWKS, writes to Convex env

# Terminal 1: Convex backend (leave running)
bunx convex dev

# Terminal 2: Frontend
bun run dev
```

Sync visual skills to the database (requires `SKILLS_SYNC_SECRET`, matching the
value set in the Convex deployment environment):

```bash
SKILLS_SYNC_SECRET=<value> bun run skills:sync
```

---

## Why I Built This

Because reading another 2,000-word explanation of backpropagation almost made me close the tab and touch grass. Because the best teacher I ever had drew everything on a whiteboard and I never forgot a single thing. Because a cafe had good coffee, a free outlet, and four uninterrupted hours on a Sunday.

The goal: make the kind of tutor I wished I had when I was learning this stuff, one that draws, moves, speaks, and actually adapts. Democratize the whiteboard.

---

*Made with too much caffeine by [Shaurya Punj](https://github.com/ShAuRyA-Noodle).*
