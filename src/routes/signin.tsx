import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useAuthActions } from '@convex-dev/auth/react'
import { useAction, useConvexAuth } from 'convex/react'
import { api } from '../../convex/_generated/api'

type SignInSearch = { reason?: 'expired' }

export const Route = createFileRoute('/signin')({
  component: SignInPage,
  validateSearch: (s: Record<string, unknown>): SignInSearch => ({
    reason: s.reason === 'expired' ? 'expired' : undefined,
  }),
})

type Mode = 'signIn' | 'signUp' | 'forgotEmail' | 'forgotCode'

function SignInPage() {
  const { signIn } = useAuthActions()
  const navigate = useNavigate()
  const { reason } = useSearch({ from: '/signin' })
  const { isLoading, isAuthenticated } = useConvexAuth()
  const gateAnonymousSignup = useAction(api.auth.gateAnonymousSignup)
  const [mode, setMode] = useState<Mode>('signIn')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resetEmail, setResetEmail] = useState('')

  // Auth-gate: an authenticated user landing on /signin is almost always a
  // stale tab — bounce them home so they don't accidentally sign out by
  // re-authenticating. Mirrors the Gate pattern used in /me.
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate({ to: '/' })
    }
  }, [isLoading, isAuthenticated, navigate])

  const handleEmail = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const data = new FormData(e.currentTarget)
    data.set('flow', mode === 'signIn' ? 'signIn' : 'signUp')
    try {
      await signIn('password', data)
      await navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleForgotEmail = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const data = new FormData(e.currentTarget)
    data.set('flow', 'reset')
    setResetEmail(String(data.get('email') ?? ''))
    try {
      await signIn('password', data)
      // Convex Auth's Password.reset triggers the OTP send — move to code step.
      setMode('forgotCode')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send reset code')
    } finally {
      setSubmitting(false)
    }
  }

  const handleForgotCode = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const data = new FormData(e.currentTarget)
    data.set('flow', 'reset-verification')
    data.set('email', resetEmail)
    try {
      await signIn('password', data)
      await navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code or password')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAnonymous = async () => {
    setError(null)
    setSubmitting(true)
    try {
      // Best-effort pre-flight gate. The server enforces the limit
      // independently, but calling this first lets us show a clean
      // "try again later" rather than a generic auth error if the
      // global anonymous-signup window is exhausted.
      const gate = await gateAnonymousSignup({})
      if (!gate.ok) {
        const minutes = Math.ceil((gate.retryAfter ?? 0) / 60000)
        setError(
          `Guest signups are temporarily disabled. Try again in ${minutes}m or use email / Google.`,
        )
        setSubmitting(false)
        return
      }
      await signIn('anonymous')
      await navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Guest sign-in failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleGoogle = async () => {
    setError(null)
    setSubmitting(true)
    try {
      await signIn('google')
      // Google redirects on success, so this call typically never resolves here.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 relative">
      <div
        className="pointer-events-none fixed inset-0 z-0 opacity-60"
        style={{
          background:
            'radial-gradient(600px 400px at 50% 30%, rgba(214,0,23,0.14), transparent 60%)',
        }}
      />
      <div className="w-full max-w-sm space-y-10 relative z-10">
        <header className="text-center space-y-3">
          <p className="kicker">visual learning</p>
          <h1 className="display-title text-7xl text-bone glitch-hover cursor-default">
            FIREFLY
          </h1>
          <p className="text-ash text-xs font-mono tracking-wide">
            your questions, lit up inside.
          </p>
          {reason === 'expired' && (
            <p
              role="status"
              className="text-[11px] text-ember font-mono tracking-wide pt-2"
            >
              session expired — please sign in again
            </p>
          )}
        </header>

        {mode === 'signIn' || mode === 'signUp' ? (
          <form onSubmit={handleEmail} className="space-y-3">
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="email"
              className="input-bmth"
            />
            <input
              name="password"
              type="password"
              required
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
              placeholder="password"
              minLength={8}
              className="input-bmth"
            />
            {mode === 'signUp' && (
              <label className="flex items-start gap-2 text-[11px] text-ash font-mono tracking-wide leading-relaxed pt-1">
                <input
                  name="ageConsent"
                  type="checkbox"
                  required
                  className="mt-0.5 accent-crimson"
                />
                <span>
                  I am 13 years or older and agree to the{' '}
                  {/*
                    Plain <a> until Eta's /legal/terms + /legal/privacy
                    routes land in routeTree.gen.ts — TanStack Router's
                    typed Link rejects unknown routes at compile time.
                    Swap to <Link to="/legal/terms"> once registered.
                  */}
                  <a
                    href="/legal/terms"
                    className="text-bone underline hover:text-crimson transition"
                  >
                    Terms
                  </a>{' '}
                  and{' '}
                  <a
                    href="/legal/privacy"
                    className="text-bone underline hover:text-crimson transition"
                  >
                    Privacy Policy
                  </a>
                  .
                </span>
              </label>
            )}
            <button type="submit" disabled={submitting} className="btn-crimson w-full">
              {submitting ? '...' : mode === 'signIn' ? 'sign in' : 'create account'}
            </button>
          </form>
        ) : mode === 'forgotEmail' ? (
          <form onSubmit={handleForgotEmail} className="space-y-3">
            <p className="text-[11px] text-ash font-mono tracking-wide">
              enter your email and we'll send a reset code
            </p>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="email"
              className="input-bmth"
            />
            <button type="submit" disabled={submitting} className="btn-crimson w-full">
              {submitting ? '...' : 'send reset code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleForgotCode} className="space-y-3">
            <p className="text-[11px] text-ash font-mono tracking-wide">
              code sent to {resetEmail}. enter it below with a new password.
            </p>
            <input
              name="code"
              type="text"
              required
              autoComplete="one-time-code"
              placeholder="8-digit code"
              inputMode="numeric"
              maxLength={8}
              className="input-bmth"
            />
            <input
              name="newPassword"
              type="password"
              required
              autoComplete="new-password"
              placeholder="new password"
              minLength={8}
              className="input-bmth"
            />
            <button type="submit" disabled={submitting} className="btn-crimson w-full">
              {submitting ? '...' : 'reset password'}
            </button>
          </form>
        )}

        <div className="flex justify-between text-[11px] uppercase tracking-[0.2em] font-mono">
          {mode === 'signIn' || mode === 'signUp' ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'signIn' ? 'signUp' : 'signIn')
                  setError(null)
                }}
                className="text-ash hover:text-bone transition"
              >
                {mode === 'signIn' ? 'create account' : 'have one / sign in'}
              </button>
              {mode === 'signIn' && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('forgotEmail')
                    setError(null)
                  }}
                  className="text-ash hover:text-bone transition"
                >
                  forgot password
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode('signIn')
                setError(null)
              }}
              className="text-ash hover:text-bone transition"
            >
              back to sign in
            </button>
          )}
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-white/5" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-void px-3 text-[10px] uppercase tracking-[0.28em] text-smoke font-mono">
              or
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={handleGoogle}
            disabled={submitting}
            className="btn-ghost w-full"
          >
            continue with google
          </button>
          <button
            type="button"
            onClick={handleAnonymous}
            disabled={submitting}
            className="btn-ghost w-full"
          >
            continue as guest · 1 free question
          </button>
        </div>

        {error && (
          <p role="alert" className="text-xs text-ember text-center font-mono tracking-wide">
            {error}
          </p>
        )}

        <p className="text-center text-[10px] font-mono text-smoke tracking-[0.18em] uppercase">
          est. on a sunday
        </p>
      </div>
    </div>
  )
}
