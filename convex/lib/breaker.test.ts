/// <reference types="vite/client" />
import { describe, test, expect, vi } from "vitest";
import { Breaker, BreakerOpenError } from "./breaker";

describe("Breaker", () => {
  test("passes through successful operations and stays closed", async () => {
    const b = new Breaker("test", 3, 1000);
    const op = vi.fn().mockResolvedValue("ok");
    for (let i = 0; i < 5; i++) {
      await expect(b.run(op)).resolves.toBe("ok");
    }
    expect(op).toHaveBeenCalledTimes(5);
  });

  test("opens after threshold failures and blocks further calls", async () => {
    const b = new Breaker("test", 3, 10_000);
    const op = vi.fn().mockRejectedValue(new Error("upstream down"));

    for (let i = 0; i < 3; i++) {
      await expect(b.run(op)).rejects.toThrow("upstream down");
    }
    // 4th call must short-circuit without invoking op.
    await expect(b.run(op)).rejects.toThrow(BreakerOpenError);
    expect(op).toHaveBeenCalledTimes(3);
  });

  test("cooldown expiry transitions to half-open and allows a probe", async () => {
    vi.useFakeTimers();
    try {
      const b = new Breaker("test", 2, 5_000);
      const fail = vi.fn().mockRejectedValue(new Error("down"));
      await expect(b.run(fail)).rejects.toThrow("down");
      await expect(b.run(fail)).rejects.toThrow("down");
      // Open now.
      await expect(b.run(fail)).rejects.toThrow(BreakerOpenError);

      vi.advanceTimersByTime(5_001);

      const ok = vi.fn().mockResolvedValue("recovered");
      await expect(b.run(ok)).resolves.toBe("recovered");

      // After a successful probe, back to closed; failures counter reset.
      await expect(b.run(ok)).resolves.toBe("recovered");
    } finally {
      vi.useRealTimers();
    }
  });

  test("half-open probe that fails immediately re-opens the breaker", async () => {
    vi.useFakeTimers();
    try {
      const b = new Breaker("test", 2, 1_000);
      const fail = vi.fn().mockRejectedValue(new Error("down"));
      await expect(b.run(fail)).rejects.toThrow("down");
      await expect(b.run(fail)).rejects.toThrow("down");
      vi.advanceTimersByTime(1_001);
      // Probe fails — breaker re-opens immediately.
      await expect(b.run(fail)).rejects.toThrow("down");
      await expect(b.run(fail)).rejects.toThrow(BreakerOpenError);
    } finally {
      vi.useRealTimers();
    }
  });
});
