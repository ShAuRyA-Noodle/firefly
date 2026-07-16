/**
 * Per-process circuit breaker for upstream APIs (Groq, Sarvam).
 *
 * Convex actions are isolate-per-invocation in the V8 runtime; this breaker
 * is NOT globally shared across all concurrent invocations. It is still
 * useful for two cases:
 *   1. A single action that makes several calls against the same provider
 *      (e.g. director + sub-agents fanning out via `directorAgent.streamText`)
 *      — once the first call fails hard, subsequent ones short-circuit.
 *   2. Long-running scheduled actions (TTS batches) that loop over chunks.
 *
 * For provider-wide circuit behavior across the whole Convex deployment,
 * use the rate limiter with a dedicated "failure" key — that's backed by
 * the Convex DB and persists. This module is intentionally lightweight.
 */

type BreakerState = "closed" | "open" | "half-open";

export class Breaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly threshold: number = 4,
    private readonly cooldownMs: number = 15_000,
  ) {}

  /**
   * Wrap an operation. Throws BreakerOpenError immediately if open and
   * still in cooldown; otherwise runs the op and updates state based on
   * whether it threw.
   */
  async run<T>(op: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.cooldownMs) {
        throw new BreakerOpenError(this.name, this.cooldownMs - (Date.now() - this.openedAt));
      }
      // Cooldown elapsed — let one request through to probe.
      this.state = "half-open";
    }
    try {
      const result = await op();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold || this.state === "half-open") {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

export class BreakerOpenError extends Error {
  constructor(public readonly breaker: string, public readonly retryAfterMs: number) {
    super(
      `[breaker:${breaker}] open — cooling down ${Math.ceil(retryAfterMs / 1000)}s before retry`,
    );
    this.name = "BreakerOpenError";
  }
}
