/**
 * Resend OTP verification provider for Convex Auth password reset.
 *
 * The `reset` slot on the Password provider takes a verification strategy;
 * this one generates an 8-digit code, stores it via Convex Auth's internal
 * machinery, and sends it via Resend. Expiry: 15 minutes.
 *
 * Fails loudly only at send time if AUTH_RESEND_KEY is missing — so the
 * stack still boots when transactional email isn't configured yet.
 */

import Resend from "@auth/core/providers/resend";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { requireEnv } from "./lib/env";
import { rateLimiter } from "./rateLimiter";

function randomDigits(length: number): string {
  // Web Crypto is available in the V8 Convex runtime. Uniform sampling via
  // rejection — 256 isn't a multiple of 10, so bytes >= 250 are discarded
  // to avoid biasing low digits.
  const out: string[] = [];
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 250) {
        out.push(String(b % 10));
        if (out.length === length) break;
      }
    }
  }
  return out.join("");
}

/**
 * SHA-256 hex of an email, lowercased + trimmed first so casing/whitespace
 * variants collapse to the same limiter key. We hash so the rate-limiter
 * component doesn't accumulate raw email addresses in its keys table.
 */
async function emailHashHex(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export const ResendOTPPasswordReset = Resend({
  id: "resend-otp-reset",
  apiKey: process.env.AUTH_RESEND_KEY ?? "",
  async generateVerificationToken() {
    return randomDigits(8);
  },
  async sendVerificationRequest(
    { identifier: email, provider, token },
    // Convex Auth's signIn handler calls `sendVerificationRequest(args, ctx)`
    // — see node_modules/@convex-dev/auth/src/server/implementation/signIn.ts.
    // The provided ctx is the action ctx (has `runMutation`), so the
    // rateLimiter component can be invoked directly. Auth.js's upstream
    // ResendConfig type doesn't know about the second arg, so we widen
    // via an inline rest tuple and narrow.
    ...rest: unknown[]
  ) {
    const ctx = rest[0] as GenericActionCtx<GenericDataModel> | undefined;

    // Rate-limit BEFORE hitting Resend — failed attempts cost us money,
    // and a flooder can mailbomb a target by repeatedly calling the
    // password-reset flow. 3 attempts/hour per email is the cap.
    if (ctx && typeof (ctx as { runMutation?: unknown }).runMutation === "function") {
      const key = await emailHashHex(email);
      const result = await rateLimiter.limit(ctx, "passwordReset", { key });
      if (!result.ok) {
        const minutes = Math.ceil((result.retryAfter ?? 0) / 60000);
        throw new Error(
          `Too many password reset attempts. Try again in ${minutes}m.`,
        );
      }
    }

    const apiKey = requireEnv("AUTH_RESEND_KEY");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Firefly <onboarding@resend.dev>",
        to: [email],
        subject: "Reset your Firefly password",
        text: [
          `Your reset code is ${token}.`,
          ``,
          `Enter it on the password reset screen within 15 minutes.`,
          `If you didn't ask to reset your password, you can ignore this email.`,
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[auth/resend] send failed ${res.status}: ${body}`);
    }
    void provider;
  },
});
