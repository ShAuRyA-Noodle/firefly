/**
 * Typed Vite env accessor. Reads VITE_-prefixed vars from import.meta.env.
 *
 * Called at module init by the Convex provider and other entrypoints; a
 * missing required var throws with a clear, actionable message before any
 * Convex client attempts to connect with `undefined` URL.
 */

type ViteEnvRecord = Record<string, string | undefined>;

function readViteEnv(): ViteEnvRecord {
  const env = (import.meta as { env?: ViteEnvRecord }).env;
  return env ?? {};
}

export class EnvConfigError extends Error {
  constructor(name: string, hint?: string) {
    const suffix = hint ? `\nHow to fix: ${hint}` : "";
    super(`[env] Missing required env var ${name}.${suffix}`);
    this.name = "EnvConfigError";
  }
}

const HINTS: Record<string, string> = {
  VITE_CONVEX_URL:
    "Run `bunx convex dev` to provision a deployment; it writes VITE_CONVEX_URL + VITE_CONVEX_SITE_URL into .env.local.",
  VITE_CONVEX_SITE_URL:
    "Run `bunx convex dev` — both VITE_CONVEX_URL and VITE_CONVEX_SITE_URL are provisioned together.",
  VITE_SENTRY_DSN:
    "Create a Sentry project and paste its DSN. Safe to leave unset in development — observability will be a no-op.",
  VITE_POSTHOG_KEY:
    "Optional. Set to a PostHog project key for client-side analytics.",
};

export function requireViteEnv(name: string): string {
  const env = readViteEnv();
  const value = env[name];
  if (!value) throw new EnvConfigError(name, HINTS[name]);
  return value;
}

export function optionalViteEnv(
  name: string,
  fallback: string | undefined = undefined,
): string | undefined {
  const env = readViteEnv();
  const value = env[name];
  return value && value.length > 0 ? value : fallback;
}

/** Convex client URL — required at boot. */
export const CONVEX_URL = requireViteEnv("VITE_CONVEX_URL");

/** Convex HTTPs site URL (OAuth redirects, auth webhooks). */
export const CONVEX_SITE_URL = optionalViteEnv("VITE_CONVEX_SITE_URL");

/** Sentry DSN — optional. When unset, observability is a no-op. */
export const SENTRY_DSN = optionalViteEnv("VITE_SENTRY_DSN");

/** PostHog key — optional. */
export const POSTHOG_KEY = optionalViteEnv("VITE_POSTHOG_KEY");
export const POSTHOG_HOST = optionalViteEnv(
  "VITE_POSTHOG_HOST",
  "https://us.i.posthog.com",
);
