/**
 * Typed server-side env accessor with fail-fast validation.
 *
 * Each consumer calls `requireEnv("GROQ_API_KEY")` at the top of its module
 * or inside handlers; if the variable is missing the thrown error names the
 * exact variable plus a human-readable hint for where to set it (Convex
 * dashboard env vars, not a local .env — Convex functions run on Convex).
 */

export type EnvVarName =
  | "GROQ_API_KEY"
  | "GROQ_MODEL_PRIMARY"
  | "GROQ_MODEL_FALLBACK"
  | "GROQ_WHISPER_MODEL"
  | "GROQ_VISION_MODEL"
  | "SARVAM_API_KEY"
  | "SARVAM_TTS_MODEL"
  | "SARVAM_VOICE"
  | "SARVAM_LANGUAGE"
  | "CONVEX_SITE_URL"
  | "SITE_URL"
  | "SENTRY_DSN"
  | "AUTH_GOOGLE_ID"
  | "AUTH_GOOGLE_SECRET"
  | "AUTH_RESEND_KEY";

const HINTS: Partial<Record<EnvVarName, string>> = {
  GROQ_API_KEY: "Set in Convex dashboard → Settings → Environment Variables (https://console.groq.com for key).",
  SARVAM_API_KEY: "Set in Convex dashboard → Settings → Environment Variables (https://dashboard.sarvam.ai for key).",
  CONVEX_SITE_URL: "Auto-provisioned by Convex at deploy time — if missing, re-run `bunx convex dev`.",
  AUTH_GOOGLE_ID: "Required for Google OAuth. Create credentials at https://console.cloud.google.com/apis/credentials.",
  AUTH_GOOGLE_SECRET: "Pair with AUTH_GOOGLE_ID from Google Cloud Console.",
  AUTH_RESEND_KEY: "Required for password-reset / verification email flows. Get from https://resend.com/api-keys.",
};

export class EnvConfigError extends Error {
  constructor(name: EnvVarName, hint?: string) {
    const suffix = hint ? `\nHow to fix: ${hint}` : "";
    super(`[env] Missing required env var ${name}.${suffix}`);
    this.name = "EnvConfigError";
  }
}

export function requireEnv(name: EnvVarName): string {
  const value = process.env[name];
  if (!value) throw new EnvConfigError(name, HINTS[name]);
  return value;
}

export function optionalEnv(name: EnvVarName, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/**
 * Asserts a group of env vars together so actions fail fast with one clear
 * message listing every missing key, not one retry at a time.
 */
export function requireEnvGroup(names: EnvVarName[]): void {
  const missing: string[] = [];
  for (const n of names) if (!process.env[n]) missing.push(n);
  if (missing.length > 0) {
    const lines = missing.map((n) => {
      const hint = HINTS[n as EnvVarName];
      return hint ? `  - ${n}: ${hint}` : `  - ${n}`;
    });
    throw new Error(`[env] Missing required env vars:\n${lines.join("\n")}`);
  }
}
