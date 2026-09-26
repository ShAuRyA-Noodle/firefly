/**
 * Central model-selection switch for every TEXT-generation LLM call.
 *
 * ONE place decides which provider + model each role uses. The director,
 * sub-agents, critic, memory extractor, and intro all resolve their model
 * here, so switching providers (e.g. Groq → OpenRouter free models) is a
 * change to THIS FILE ONLY — no call sites move.
 *
 * Specialized calls stay on their own providers and are NOT routed here:
 *   - moderation  → Groq Llama-Guard (a specific safety classifier)
 *   - vision OCR  → Groq vision
 *   - whisper     → Groq audio transcription
 *   - tts         → Sarvam
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SWITCHING TO OPENROUTER (free models) — do this on a TTY shell:
 *
 *   1. Install the provider:
 *        pnpm add @openrouter/ai-sdk-provider
 *      (if pnpm complains about the store, run `pnpm install` once first)
 *
 *   2. Set env in the Convex dashboard (or `.env.local`):
 *        OPENROUTER_API_KEY=sk-or-...
 *        MODEL_PRIMARY=meta-llama/llama-3.3-70b-instruct:free
 *        MODEL_FALLBACK=google/gemini-2.0-flash-exp:free
 *        MODEL_UTILITY=meta-llama/llama-3.3-70b-instruct:free
 *      (pick any tool-capable free models; these are just examples.)
 *
 *   3. Uncomment the OPENROUTER BLOCK below and the import at the top.
 *
 * With no OPENROUTER_API_KEY set, everything runs on Groq exactly as before —
 * so the app keeps working until you flip it.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { groq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";

// The concrete model type the @convex-dev/agent Agent + the `ai` SDK accept.
// Inferred from groq() so it always matches the installed SDK major (avoids
// the LanguageModelV2/V3 skew that a hand-written `LanguageModel` annotation
// causes). The OpenRouter provider's models are structurally compatible.
export type TextModel = ReturnType<typeof groq>;

// Active when OPENROUTER_API_KEY is set; otherwise null → falls back to Groq.
// OpenRouter is OpenAI-chat-compatible, so we drive it through @ai-sdk/openai
// (same provider generation as @ai-sdk/groq → spec-compatible with the
// installed ai@6 + @convex-dev/agent). `.chat()` uses /chat/completions,
// which is the endpoint OpenRouter implements.
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const _or = OPENROUTER_KEY
  ? createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_KEY,
      name: "openrouter",
    })
  : null;
const openrouter: null | ((id: string) => TextModel) = _or
  ? (id: string) => _or.chat(id) as unknown as TextModel
  : null;

// Groq defaults (current behavior). gpt-oss-120b has the strongest tool-use
// on Groq's free tier; llama-3.3-70b is the fallback. Kept as the resolved
// default so a stale env value can never silently override — env only wins
// when explicitly, non-emptily set (see envOr).
// Groq rate-limits PER MODEL. The director (tool-calling) and the 4 sub-agents
// used to share one model's tokens-per-minute bucket, so a single question
// burst-tripped the limit. Splitting them across different models gives each
// its own bucket: director on a capable tool-use model, sub-agents on a small
// fast high-throughput model (plain JSON generation needs no tool-calling).
const GROQ_DIRECTOR = "llama-3.3-70b-versatile";
const GROQ_PRIMARY = "llama-3.1-8b-instant";
const GROQ_FALLBACK = "llama-3.3-70b-versatile";
const GROQ_UTILITY = "llama-3.1-8b-instant";

// OpenRouter defaults (used when the OpenRouter provider is active and the
// MODEL_* env vars are unset). Newest DeepSeek V4: Pro for the reasoning +
// tool-use roles, Flash (cheap, fast, same family) for fallback + utility.
// All tool-capable. Override per-role via MODEL_PRIMARY/FALLBACK/UTILITY.
// OpenRouter defaults — 100% FREE tier (":free" = $0 in AND $0 out), verified
// live for tool-calling + latency before selection:
//   nemotron-3-ultra-550b : 550B frontier model, tool-calls OK, ~1.7s, 1M ctx
//   gpt-oss-20b           : different family → real fallback diversity, ~6s
// Free DeepSeek/Kimi/Gemini-Flash variants no longer exist on OpenRouter (all
// paid), and qwen3-next / llama-3.3 free endpoints return 429 under load.
// Cost per question: $0.00.
// Chosen by live measurement, not vibes. The director must dispatch FOUR
// frames then call done(); most models under-dispatch:
//   deepseek-v4-flash          → 4/4 launches ✅  ~10s   $0.09/$0.18 per M
//   deepseek-v4-pro            → 1/4 launches ❌  (under-dispatches)
//   nemotron-3-ultra-550b:free → 1/4 launches ❌  + ~25s/frame (UI looked stuck)
//   groq llama-3.3-70b         → 4/4 but flakier frame quality
// V4-Flash is technically paid but lands at ~$0.004/question — inside the
// $0.005 ceiling — and $1 of credit buys ~250 questions. Utility jobs (critic,
// memory, intro) stay on a FREE model so they cost nothing.
const OR_DIRECTOR = "deepseek/deepseek-v4-flash";
const OR_PRIMARY = "deepseek/deepseek-v4-flash";
const OR_FALLBACK = "openai/gpt-oss-20b:free";
const OR_UTILITY = "openai/gpt-oss-20b:free";

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

/**
 * Resolve a model for a role. When OpenRouter is configured, every role can
 * be pointed at a (free) OpenRouter model via env; otherwise we use the Groq
 * default. The Groq id is passed to openrouter only as a last-resort label
 * and is never used while openrouter is null.
 */
function resolve(envName: string, orDefault: string, groqId: string): TextModel {
  if (openrouter) {
    return openrouter(envOr(envName, orDefault));
  }
  return groq(groqId);
}

/** The director's orchestration model (tool-calling) — its own rate bucket. */
export function directorTextModel(): TextModel {
  return resolve("MODEL_DIRECTOR", OR_DIRECTOR, GROQ_DIRECTOR);
}

/** Sub-agent frame generation (plain JSON) — fast, high-throughput model. */
export function primaryTextModel(): TextModel {
  return resolve("MODEL_PRIMARY", OR_PRIMARY, GROQ_PRIMARY);
}

/** Sub-agent fallback attempt when the primary emits malformed tool calls. */
export function fallbackTextModel(): TextModel {
  return resolve("MODEL_FALLBACK", OR_FALLBACK, GROQ_FALLBACK);
}

/** Cheaper text jobs: critic, memory extraction, intro warmup. */
export function utilityTextModel(): TextModel {
  return resolve("MODEL_UTILITY", OR_UTILITY, GROQ_UTILITY);
}

/**
 * Is any text-generation provider configured? Best-effort callers (the
 * critic) skip entirely when false instead of throwing. True when OpenRouter
 * is wired OR a Groq key is present.
 */
export function hasTextProvider(): boolean {
  return openrouter !== null || Boolean(process.env.GROQ_API_KEY);
}
