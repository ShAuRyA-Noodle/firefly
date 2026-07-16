/**
 * Client-side error/metric reporting.
 *
 * Thin facade that stays a no-op when no DSN is configured. We lazy-import
 * `@sentry/browser` only when an env var is set so dev builds don't pull
 * Sentry into the bundle. A project can later add PostHog/LogRocket behind
 * the same `track()` call without touching feature code.
 *
 * NOTE: `@sentry/browser` is installed via package.json (managed by the Zeta
 * agent / project tooling). It is runtime-required for actual reporting. If
 * the package is not installed, the dynamic import below fails gracefully
 * and the facade no-ops — this is the intentional dev-without-Sentry path.
 */

import { SENTRY_DSN } from "./env";

type Ctx = Record<string, unknown>;

// We type the SDK as `any` so the file compiles whether or not
// `@sentry/browser` is currently installed. Zeta installs the package via
// package.json; until then the module-not-found is acceptable. The runtime
// path is guarded by the dynamic import in `ensureSentry()`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SentryMod = any;

let sentryReady = false;
let sentry: SentryMod | null = null;

function isDev(): boolean {
  // Vite injects MODE / DEV; fall back to NODE_ENV for non-Vite contexts (tests).
  const meta = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
  if (meta?.DEV !== undefined) return Boolean(meta.DEV);
  if (meta?.MODE) return meta.MODE !== "production";
  return typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
}

async function ensureSentry(): Promise<SentryMod | null> {
  if (sentryReady) return sentry;
  sentryReady = true;
  if (!SENTRY_DSN) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("@sentry/browser");
    mod.init({
      dsn: SENTRY_DSN,
      tracesSampleRate: 0.1,
      // Strip query strings — our URLs can contain auth tokens.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      beforeBreadcrumb: (b: any) => {
        if (b.data && typeof b.data.url === "string") {
          b.data.url = b.data.url.split("?")[0];
        }
        return b;
      },
    });
    sentry = mod;
    return mod;
  } catch (err) {
    // Sentry isn't installed or import failed — stay a no-op.
    console.warn("[observability] sentry init failed:", err);
    return null;
  }
}

export function reportError(err: unknown, ctx: Ctx = {}): void {
  const fallback = () => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reportError]`, msg, ctx);
  };
  void ensureSentry().then((s) => {
    if (!s) return fallback();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.withScope((scope: any) => {
      for (const [k, v] of Object.entries(ctx)) {
        scope.setExtra(k, v);
      }
      s.captureException(err);
    });
  });
  if (!SENTRY_DSN) fallback();
}

export function track(event: string, ctx: Ctx = {}): void {
  // Placeholder — PostHog/analytics hook for later. For now, route to
  // Sentry as a breadcrumb so it's attached to any subsequent error.
  if (!SENTRY_DSN) {
    // Dev with no DSN: surface the event for debuggability. Prod with no
    // DSN: stay completely silent — no spam in production consoles.
    if (isDev()) console.debug(`[track] ${event}`, ctx);
    return;
  }
  void ensureSentry().then((s) => {
    s?.addBreadcrumb({ message: event, data: ctx, level: "info" });
  });
}

/**
 * Flush queued Sentry events. Intended to be wired into a `beforeunload`
 * listener at the app root so in-flight error reports survive a navigation.
 *
 * NOTE: __root.tsx is owned by the Eta agent. Eta should call this on
 * `beforeunload`:
 *
 *   window.addEventListener('beforeunload', () => { void flush(); });
 *
 * No-ops when the SDK isn't loaded.
 */
export async function flush(timeoutMs = 2000): Promise<boolean> {
  const s = await ensureSentry();
  if (!s) return true;
  try {
    return await s.flush(timeoutMs);
  } catch (err) {
    console.warn("[observability] flush failed:", err);
    return false;
  }
}
