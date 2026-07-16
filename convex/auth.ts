// Convex Auth: Password + Anonymous + Google OAuth + email reset codes.
//
// Google OAuth is enabled conditionally — if AUTH_GOOGLE_ID isn't set in the
// Convex dashboard, we omit the provider so the stack still boots cleanly
// for a developer who hasn't created Google credentials yet. The signin
// page reads the same flag (exposed via a query) to hide the Google button.
import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import Google from "@auth/core/providers/google";
import { ResendOTPPasswordReset } from "./authResend";
import { action } from "./_generated/server";
import { rateLimiter } from "./rateLimiter";

const providers: Parameters<typeof convexAuth>[0]["providers"] = [
  // Password with a ResendOTP reset code flow — the `reset` verification
  // sends a one-time code via Resend. If AUTH_RESEND_KEY isn't set, the
  // reset flow will throw at use time; sign-in and sign-up still work.
  Password({ reset: ResendOTPPasswordReset }),
  Anonymous,
];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(Google);
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers,
});

/**
 * Pre-flight gate the client must call before `signIn('anonymous')`.
 *
 * Rationale: Convex Auth's Anonymous provider has no pre-signup hook and
 * exposes no IP inside the auth context, so we can't reject abusive
 * traffic at the provider boundary. Instead, the SignInPage calls this
 * action first; if the global anonymous-signup window is exhausted, the
 * client never reaches `signIn('anonymous')` and the user is told to use
 * email/Google.
 *
 * This is best-effort defense in depth. A bad actor can call
 * `signIn('anonymous')` directly without first calling this gate — the
 * limiter then doesn't fire. We accept that risk because the real
 * downstream costs (LLM, TTS) are gated by per-user limiters that DO fire
 * on every action call.
 *
 * Public so unauthenticated clients can call it (no auth required by
 * design — the anonymous user doesn't exist yet). No args; the limiter
 * key is the literal "global" so the rate is system-wide.
 */
export const gateAnonymousSignup = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; retryAfter?: number }> => {
    const result = await rateLimiter.limit(ctx, "anonymousSignup", {
      key: "global",
    });
    if (!result.ok) {
      return { ok: false, retryAfter: result.retryAfter };
    }
    return { ok: true };
  },
});
