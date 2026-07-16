import { useCallback } from 'react'

// First-run welcome panel. Renders only when no thread exists yet (caller's
// guard) so the user lands on a real choice rather than an empty input.
//
// Click → writes the prompt to localStorage["firefly.pendingPrompt"] and
// dispatches a `firefly:prompt-prefill` CustomEvent. The index.tsx host
// listens, prefills the PromptInput, and the user can submit (or edit
// first). The localStorage handoff is the durable channel so a refresh
// mid-onboarding doesn't lose the picked prompt.
//
// "skip" sets `firefly.onboardingSeen=1` and dispatches `firefly:onboarding-dismiss`
// so the welcome panel disappears immediately without a reload.

const EXAMPLE_PROMPTS: { label: string; prompt: string; tag: string }[] = [
  {
    tag: 'calc',
    label: 'Explain how derivatives work',
    prompt: 'Explain how derivatives work',
  },
  {
    tag: 'net',
    label: 'Show me how TCP three-way handshake works',
    prompt: 'Show me how TCP three-way handshake works',
  },
  {
    tag: 'bio',
    label: 'What is photosynthesis at the molecular level?',
    prompt: 'What is photosynthesis at the molecular level?',
  },
]

export function Onboarding({ onDismiss }: { onDismiss?: () => void }) {
  const pickPrompt = useCallback((prompt: string) => {
    try {
      localStorage.setItem('firefly.pendingPrompt', prompt)
      localStorage.setItem('firefly.onboardingSeen', '1')
    } catch {
      // localStorage can throw in private mode / disabled storage — the
      // CustomEvent below still fires so the live session works.
    }
    window.dispatchEvent(
      new CustomEvent('firefly:prompt-prefill', { detail: { prompt } }),
    )
    onDismiss?.()
  }, [onDismiss])

  const skip = useCallback(() => {
    try {
      localStorage.setItem('firefly.onboardingSeen', '1')
    } catch {
      // Ignore — dismissal still works in-memory via onDismiss().
    }
    window.dispatchEvent(new CustomEvent('firefly:onboarding-dismiss'))
    onDismiss?.()
  }, [onDismiss])

  return (
    <div
      className="frame-content text-center space-y-8"
      role="region"
      aria-label="Welcome to Firefly. Pick an example or type your own."
    >
      <div className="space-y-4">
        <p className="kicker text-crimson">firefly · visual learning</p>
        <h1 className="display-title text-6xl md:text-7xl text-bone glitch-hover cursor-default leading-[0.9]">
          ASK<br />SEE<br />UNDERSTAND
        </h1>
        <p className="text-ash text-xs font-mono tracking-[0.18em] uppercase max-w-sm mx-auto">
          your questions, lit up inside.
        </p>
      </div>

      <div className="space-y-3 max-w-md mx-auto pt-2">
        <p className="text-[10px] font-mono tracking-[0.32em] uppercase text-smoke">
          try one to start
        </p>
        <div className="space-y-2">
          {EXAMPLE_PROMPTS.map((ex) => (
            <button
              key={ex.tag}
              type="button"
              onClick={() => pickPrompt(ex.prompt)}
              className="group w-full text-left px-4 py-3 rounded-sm border border-white/8 bg-white/[0.02] hover:border-crimson/40 hover:bg-crimson/[0.04] transition-all focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none"
              aria-label={`Use example prompt: ${ex.label}`}
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="text-[10px] font-mono tracking-[0.24em] uppercase text-crimson/70 group-hover:text-crimson transition-colors w-10 shrink-0"
                >
                  {ex.tag}
                </span>
                <span className="text-bone text-sm font-mono leading-snug flex-1">
                  {ex.label}
                </span>
                <svg
                  className="ml-auto shrink-0 w-4 h-4 text-smoke group-hover:text-crimson transition-colors"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M6 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={skip}
          className="mt-4 text-[10px] font-mono tracking-[0.24em] uppercase text-smoke hover:text-ash transition-colors focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none rounded-sm px-2 py-1"
        >
          skip · type your own
        </button>
      </div>
    </div>
  )
}

export default Onboarding
