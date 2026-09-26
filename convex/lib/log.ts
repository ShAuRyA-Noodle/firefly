/**
 * Structured logging helpers for Convex functions.
 *
 * Single-line JSON per event, stable field names, so Convex Log Streams /
 * Sentry / Datadog downstream can parse without regex. Every call stamps
 * `ts` and `level`; the caller supplies `event` (kebab-cased) and an
 * arbitrary context object.
 *
 * Use `logError(err, { event, ...ctx })` for exceptions so the message +
 * stack are captured alongside the structured context.
 */

type Level = "debug" | "info" | "warn" | "error";
type Ctx = Record<string, unknown>;

function emit(level: Level, event: string, ctx: Ctx = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, ctx?: Ctx) => emit("debug", event, ctx),
  info: (event: string, ctx?: Ctx) => emit("info", event, ctx),
  warn: (event: string, ctx?: Ctx) => emit("warn", event, ctx),
  error: (event: string, ctx?: Ctx) => emit("error", event, ctx),
};

export function logError(err: unknown, ctx: Ctx & { event: string }): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  emit("error", ctx.event, { ...ctx, message, stack });
}

/**
 * Wrap an async function so any thrown error is logged with `event` before
 * re-throwing. Useful in scheduled actions where the caller has no chance
 * to see the failure otherwise.
 */
export async function logged<T>(
  event: string,
  fn: () => Promise<T>,
  ctx: Ctx = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logError(err, { event, ...ctx });
    throw err;
  }
}
