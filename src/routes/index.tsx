import { useState, useCallback, useEffect, useRef } from 'react'
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { useAction, useQuery, useConvexAuth } from 'convex/react'
import { useAuthActions } from '@convex-dev/auth/react'
import { api } from '../../convex/_generated/api'
import { FrameContainer } from '../components/FrameContainer'
import { PromptInput } from '../components/PromptInput'
import TalkingHead from '../components/TalkingHead'
import type { TalkingHeadHandle } from '../components/TalkingHead'
import { Onboarding } from '../components/Onboarding'
import { KeyboardHelp } from '../components/KeyboardHelp'
import { reportError } from '#/lib/observability'

export const Route = createFileRoute('/')({ component: AppShell })

function AppShell() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <div className="canvas" />
  return <AuthGate />
}

function AuthGate() {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate({ to: '/signin' })
    }
  }, [isLoading, isAuthenticated, navigate])

  if (isLoading || !isAuthenticated) {
    return (
      <div className="canvas flex items-center justify-center">
        <div className="font-mono text-crimson text-[11px] tracking-[0.32em] uppercase loading-breathe">
          loading
        </div>
      </div>
    )
  }
  return <App />
}

function App() {
  const { signOut } = useAuthActions()
  const [threadId, setThreadId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [audioPaused, setAudioPaused] = useState(false)
  // First-run onboarding visibility. Initialized from localStorage on mount
  // so a returning user never sees the welcome cards. We default to `false`
  // for the SSR-equivalent first paint and flip to `true` in an effect, which
  // also avoids a hydration flash if anything reads `localStorage` server-side.
  const [showOnboarding, setShowOnboarding] = useState(false)
  const loadingRef = useRef(false)
  const threadRef = useRef<string | null>(null)
  const doneCountRef = useRef(0)
  const headRef = useRef<TalkingHeadHandle>(null)
  // ID-keyed sets survive array reorder + late-arriving low-step frames; a
  // count-based ref would replay or skip rows when sort order shifted.
  const spokenIdsRef = useRef<Set<string>>(new Set())
  const audioPlayedIds = useRef<Set<string>>(new Set())
  const branchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const createThread = useAction(api.chat.createNewThread)
  const sendMessage = useAction(api.chat.sendMessageStreaming)
  const createBranch = useAction(api.chat.createBranchThread)
  const generateUploadUrl = useAction(api.vision.generateUploadUrl)
  const sendImageMessage = useAction(api.chat.sendImageMessage)
  const ancestors = useQuery(
    api.threads.ancestorTrail,
    threadId ? { agentThreadId: threadId } : 'skip'
  )

  loadingRef.current = isLoading
  threadRef.current = threadId

  const explanations = useQuery(
    api.explanations.getByThread,
    threadId ? { threadId } : 'skip'
  )
  const threadProgress = useQuery(
    api.threads.getMyThreadProgress,
    threadId ? { agentThreadId: threadId } : 'skip'
  )

  const doneCount = explanations?.filter((e) => e.skill === '_done').length ?? 0
  useEffect(() => {
    if (doneCount > doneCountRef.current) {
      setIsLoading(false)
      headRef.current?.setMood('idle')
    }
    doneCountRef.current = doneCount
  }, [doneCount])

  // Once the first frame of a branch lands, the safety timeout is moot —
  // the branch succeeded and isLoading will clear via the done-count path.
  const firstFrameId = explanations?.find(
    (e) => e.skill !== '_done' && e.skill !== 'intro',
  )?._id
  useEffect(() => {
    if (firstFrameId && branchTimeoutRef.current) {
      clearTimeout(branchTimeoutRef.current)
      branchTimeoutRef.current = null
    }
  }, [firstFrameId])

  useEffect(() => {
    if (!explanations || !headRef.current) return

    const sorted = [...explanations].sort((a, b) => {
      // Narrate questions in ask-order, frames within a question in step
      // order — otherwise a follow-up's step-1 audio would jump ahead of the
      // prior question's later frames.
      const ta = a.turnIndex ?? 0
      const tb = b.turnIndex ?? 0
      if (ta !== tb) return ta - tb
      const sa = a.step ?? Infinity
      const sb = b.step ?? Infinity
      if (sa !== sb) return sa - sb
      return a._creationTime - b._creationTime
    })

    // Enqueue audio in step order — ordered playback survives parallel arrival.
    // A frame is "ready" once audio + timings are both present. We only
    // enqueue rows that haven't been seen before; the queue itself handles
    // serialization across what was dispatched in parallel.
    for (const exp of sorted) {
      if (audioPlayedIds.current.has(exp._id)) continue
      if (exp.audioUrl && exp.audioTimings) {
        audioPlayedIds.current.add(exp._id)
        headRef.current.queueAudio(exp.audioUrl, JSON.parse(exp.audioTimings))
      }
    }

    // NOTE: there is exactly ONE speech channel — the audio queue above.
    // A web-speech fallback used to speak any frame whose TTS hadn't landed
    // yet, but TTS *always* lands a moment later and then speakAudio narrated
    // the same text a second time — two voices talking over each other. The
    // queue serializes playback, so frames simply speak when their audio is
    // ready.
    for (const exp of explanations) spokenIdsRef.current.add(exp._id)
  }, [explanations])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      // Use closest() so nested element activation (a span inside a button,
      // etc.) still hits the interactive ancestor and bypasses our handler.
      // This unblocks Quiz/ActionCard/branch button keyboard activation.
      const target = e.target as Element | null
      if (
        target?.closest?.(
          'input, textarea, button, a, select, [contenteditable="true"]',
        )
      ) {
        return
      }
      e.preventDefault()
      headRef.current?.stopSpeaking()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // First-run onboarding: show only when the user has no thread yet AND no
  // explanations AND has never dismissed it. The localStorage read happens
  // in an effect (post-mount) so we don't trigger a hydration mismatch.
  useEffect(() => {
    try {
      const seen = localStorage.getItem('firefly.onboardingSeen') === '1'
      if (!seen) setShowOnboarding(true)
    } catch {
      // Storage disabled — fall back to showing onboarding once per session.
      setShowOnboarding(true)
    }

    // Listen for explicit dismissals from the Onboarding component (e.g.
    // skip button, picking an example) so we don't have to re-poll storage.
    const onDismiss = () => setShowOnboarding(false)
    window.addEventListener('firefly:onboarding-dismiss', onDismiss)
    // Picking an example also dismisses — same effect, different intent.
    const onPrefill = () => setShowOnboarding(false)
    window.addEventListener('firefly:prompt-prefill', onPrefill)
    return () => {
      window.removeEventListener('firefly:onboarding-dismiss', onDismiss)
      window.removeEventListener('firefly:prompt-prefill', onPrefill)
    }
  }, [])

  const navigate = useNavigate()

  const handleAuthFailure = useCallback(() => {
    // Reset local thread state so the next sign-in doesn't resurrect a thread
    // the user doesn't own. The redirect preserves the URL they tried to reach.
    setThreadId(null)
    threadRef.current = null
    navigate({ to: '/signin', search: { reason: 'expired' } as never })
  }, [navigate])

  const handleBranch = useCallback(async (frameId: string) => {
    // Show progress UI immediately so the user gets feedback while the
    // branch action is in flight + the new thread's first frame loads.
    // The new thread's useQuery returns undefined briefly, so we lean on
    // isLoading to keep the "branching" affordance visible. The done-count
    // effect (or first frame) will clear it.
    setIsLoading(true)
    setErrorMsg(null)
    if (branchTimeoutRef.current) clearTimeout(branchTimeoutRef.current)
    // Safety net: if branch creation hangs (network drop, server timeout)
    // we don't want to lock the user in a "loading" state forever.
    branchTimeoutRef.current = setTimeout(() => {
      setIsLoading(false)
      setErrorMsg('branch is taking too long — try again')
      branchTimeoutRef.current = null
    }, 5000)
    try {
      const newThreadId = await createBranch({
        fromFrameId: frameId as Parameters<typeof createBranch>[0]['fromFrameId'],
      })
      setThreadId(newThreadId)
      threadRef.current = newThreadId
      // Reset per-thread local state so the new branch starts clean.
      audioPlayedIds.current.clear()
      spokenIdsRef.current.clear()
      doneCountRef.current = 0
      headRef.current?.stopSpeaking()
      headRef.current?.setMood('idle')
    } catch (err) {
      if (branchTimeoutRef.current) {
        clearTimeout(branchTimeoutRef.current)
        branchTimeoutRef.current = null
      }
      setIsLoading(false)
      console.error('[branch] failed:', err)
      reportError(err, { where: 'createBranchThread', frameId })
      setErrorMsg('could not branch — try again')
    }
  }, [createBranch])

  // Clean up branch safety timeout on unmount.
  useEffect(() => {
    return () => {
      if (branchTimeoutRef.current) clearTimeout(branchTimeoutRef.current)
    }
  }, [])

  const handleSubmit = useCallback(async (text: string) => {
    // ActionCards used to be able to call this with undefined (no `prompt`
    // prop), which silently did nothing and made the cards feel dead.
    if (typeof text !== 'string' || !text.trim()) return
    if (loadingRef.current) return
    setIsLoading(true)
    setErrorMsg(null)

    // Warm the AudioContext on this user gesture, but do NOT speak the
    // question back — the intro narration lands a second later and the two
    // voices talked over each other.
    headRef.current?.warmUpAudio()
    headRef.current?.setMood('thinking')

    try {
      let currentThreadId = threadRef.current
      if (!currentThreadId) {
        currentThreadId = await createThread({})
        setThreadId(currentThreadId)
      }
      sendMessage({ threadId: currentThreadId, prompt: text }).catch((err) => {
        console.error('Agent error:', err)
        reportError(err, { where: 'sendMessageStreaming', threadId: currentThreadId })
        if (isAuthError(err)) {
          handleAuthFailure()
          return
        }
        setErrorMsg(humanizeError(err))
        setIsLoading(false)
      })
    } catch (err) {
      console.error('Failed to send message:', err)
      reportError(err, { where: 'handleSubmit' })
      if (isAuthError(err)) {
        handleAuthFailure()
        return
      }
      setErrorMsg(humanizeError(err))
      setIsLoading(false)
    }
  }, [createThread, sendMessage, handleAuthFailure])

  const handleImageSubmit = useCallback(async (file: File) => {
    if (loadingRef.current) return
    setIsLoading(true)
    setErrorMsg(null)

    headRef.current?.warmUpAudio()
    headRef.current?.setMood('thinking')

    try {
      // 1. Mint a signed upload URL — convex action returns the raw string.
      const uploadUrl = await generateUploadUrl()

      // 2. POST the file to Convex storage. The response body is JSON
      //    `{ storageId: string }` per Convex's storage upload contract.
      //    Validate the shape before passing storageId to the action so a
      //    malformed response surfaces as a clear UI error instead of a
      //    cryptic "expected Id<_storage>" downstream.
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!uploadRes.ok) {
        throw new Error(`Upload failed (${uploadRes.status})`)
      }
      const uploadJson: unknown = await uploadRes.json()
      const storageId =
        typeof uploadJson === 'object' &&
        uploadJson !== null &&
        'storageId' in uploadJson &&
        typeof (uploadJson as { storageId: unknown }).storageId === 'string'
          ? (uploadJson as { storageId: string }).storageId
          : null
      if (!storageId) {
        throw new Error('Upload response missing storageId')
      }

      // 3. Make sure we have a thread to attach the question to.
      let currentThreadId = threadRef.current
      if (!currentThreadId) {
        currentThreadId = await createThread({})
        setThreadId(currentThreadId)
      }

      // 4. Fire the streaming action. Errors bubble through the same
      //    humanizeError path the typed-text submit uses, so the user
      //    sees a friendly message regardless of input modality.
      sendImageMessage({
        threadId: currentThreadId,
        storageId: storageId as Parameters<typeof sendImageMessage>[0]['storageId'],
      })
        .then((res) => {
          if (res?.question) {
            // Speak the extracted question now that we have it — gives
            // the user audible confirmation that the OCR worked.
            headRef.current?.speak(res.question)
          }
        })
        .catch((err) => {
          console.error('Image agent error:', err)
          reportError(err, { where: 'sendImageMessage', threadId: currentThreadId })
          if (isAuthError(err)) {
            handleAuthFailure()
            return
          }
          setErrorMsg(humanizeError(err))
          setIsLoading(false)
        })
    } catch (err) {
      console.error('Failed to send image:', err)
      reportError(err, { where: 'handleImageSubmit' })
      if (isAuthError(err)) {
        handleAuthFailure()
        return
      }
      setErrorMsg(humanizeError(err))
      setIsLoading(false)
    }
  }, [createThread, generateUploadUrl, sendImageMessage, handleAuthFailure])

  const hasFrames = (explanations?.filter((e) => e.skill !== '_done').length ?? 0) > 0 || isLoading

  // Onboarding shows ONLY when the user is at the empty welcome state:
  // no active thread, no explanations, not loading. Anything else means
  // they're mid-flow and we shouldn't shove a tutorial in front of them.
  const onboardingVisible =
    showOnboarding &&
    threadId === null &&
    !isLoading &&
    (explanations === undefined || explanations.length === 0)

  // Progress strip while frames stream in parallel. Expected comes from the
  // director's done(totalFrames=N) announcement; actual is the live count of
  // rendered frames. We hide the strip once done is marked (or before the
  // director has announced, to avoid a "0 of 0" flash).
  // Scope the "N of M" to the CURRENT question's frames. A thread's
  // append-history holds every prior question's frames too; counting them all
  // would show "7 / 3" on a 3-frame follow-up.
  const currentTurnIndex = threadProgress?.currentTurnIndex ?? null
  const framesRendered = explanations?.filter(
    (e) =>
      e.skill !== '_done' &&
      e.skill !== 'intro' &&
      (currentTurnIndex == null || (e.turnIndex ?? 0) === currentTurnIndex)
  ).length ?? 0
  const expectedFrames = threadProgress?.expectedFrames ?? null
  // Mutex with the error alert: never stack two badges in the same screen
  // region. Error wins because it demands attention; progress just informs.
  const showProgress =
    isLoading &&
    expectedFrames != null &&
    !threadProgress?.doneMarkedAt &&
    !errorMsg

  return (
    <div className="canvas">
      <div className="fixed top-4 right-4 z-50 flex items-center gap-4">
        <Link
          to="/me"
          className="text-[10px] uppercase tracking-[0.24em] text-ash hover:text-crimson transition font-mono"
          aria-label="Your learning"
        >
          learning
        </Link>
        <button
          onClick={() => signOut()}
          className="text-[10px] uppercase tracking-[0.24em] text-ash hover:text-crimson transition font-mono"
          aria-label="Sign out"
        >
          sign out
        </button>
      </div>

      <div className={hasFrames ? 'talking-head-side' : 'talking-head-bg'}>
        <TalkingHead ref={headRef} />
      </div>

      <FrameContainer
        explanations={explanations ?? []}
        isLoading={isLoading}
        onAction={handleSubmit}
        onBranch={handleBranch}
      />

      {onboardingVisible && (
        // Overlay sits above the FrameContainer welcome frame and fills the
        // viewport with the void background so the underlying welcome text
        // doesn't double-render. We can't suppress the welcome frame from
        // within FrameContainer (other agent owns it), so the cover is the
        // simplest non-invasive approach. Top/bottom padding leaves room
        // for the persistent prompt input + nav chrome.
        <div
          className="fixed inset-0 z-30 flex items-center justify-center px-6 pt-20 pb-32 bg-void/95 backdrop-blur-sm overflow-y-auto"
          role="presentation"
        >
          <div className="w-full max-w-2xl">
            <Onboarding onDismiss={() => setShowOnboarding(false)} />
          </div>
        </div>
      )}

      <KeyboardHelp />
      {ancestors && ancestors.length > 0 && (
        <nav
          aria-label="Branch path"
          className="fixed top-4 left-4 z-40 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-mono text-ash"
        >
          {ancestors.map((a, i) => (
            <span key={a.agentThreadId} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setThreadId(a.agentThreadId)
                  threadRef.current = a.agentThreadId
                  audioPlayedIds.current.clear()
                  spokenIdsRef.current.clear()
                  doneCountRef.current = 0
                  headRef.current?.stopSpeaking()
                }}
                className="hover:text-crimson transition truncate max-w-[140px]"
                title={a.title ?? 'untitled'}
              >
                {a.title ?? 'root'}
              </button>
              {i < ancestors.length - 1 && <span className="text-smoke">/</span>}
            </span>
          ))}
          <span className="text-smoke">/</span>
          <span className="text-crimson">this branch</span>
        </nav>
      )}
      <PromptInput
        onSubmit={handleSubmit}
        onImageSubmit={handleImageSubmit}
        isLoading={isLoading}
      />

      {hasFrames && (
        <div
          className="fixed bottom-4 right-4 z-40 flex items-center gap-2 bg-void/85 border border-white/10 rounded-sm px-2.5 py-2 backdrop-blur"
          aria-label="Narration controls"
        >
          <button
            type="button"
            onClick={() => {
              if (audioPaused) {
                headRef.current?.resume()
                setAudioPaused(false)
              } else {
                headRef.current?.pause()
                setAudioPaused(true)
              }
            }}
            className="text-[10px] uppercase tracking-[0.2em] text-ash hover:text-crimson transition font-mono px-2"
            aria-label={audioPaused ? 'Resume narration' : 'Pause narration'}
          >
            {audioPaused ? 'play' : 'pause'}
          </button>
          <span className="text-smoke text-[10px]">·</span>
          <button
            type="button"
            onClick={() => {
              headRef.current?.stopSpeaking()
              setAudioPaused(false)
            }}
            className="text-[10px] uppercase tracking-[0.2em] text-ash hover:text-crimson transition font-mono px-2"
            aria-label="Stop narration"
          >
            stop
          </button>
        </div>
      )}

      {showProgress && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-32 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-void/80 border border-crimson/30 px-4 py-2 rounded-sm backdrop-blur"
        >
          <span className="text-[10px] uppercase tracking-[0.24em] text-ash font-mono">
            frames · {framesRendered} / {expectedFrames}
          </span>
          <div className="w-24 h-[2px] bg-white/5 rounded overflow-hidden">
            <div
              className="h-full bg-crimson transition-all duration-300"
              style={{
                width: `${Math.min(100, (framesRendered / expectedFrames) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-40 bg-void/90 border border-crimson/60 text-bone text-[11px] font-mono uppercase tracking-[0.18em] px-4 py-2 rounded-sm backdrop-blur pulse-crimson"
        >
          {errorMsg}
        </div>
      )}
    </div>
  )
}

function humanizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/safety filter|prompt blocked/i.test(msg)) return "that question is outside what i can answer — try rephrasing"
  if (/daily.*limit|over.*daily|out of.*today/i.test(msg)) return "daily question cap reached — back tomorrow"
  if (/rate.?limit|too many/i.test(msg)) return "slow down — you're over the hourly limit"
  if (/not authenticated/i.test(msg)) return 'session expired — sign in again'
  if (/forbidden/i.test(msg)) return "that thread isn't yours"
  if (/could not read a question|no_question_found/i.test(msg)) return "couldn't read a question from that image — try another photo or type it"
  if (/image too large/i.test(msg)) return 'image too large — max 10 mb'
  if (/unsupported image type|isn'?t an image/i.test(msg)) return 'unsupported image — use png, jpeg, webp, or gif'
  if (/upload failed|upload response/i.test(msg)) return 'upload failed — check your connection and retry'
  return 'something went wrong — try again'
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not authenticated|unauthori[sz]ed/i.test(msg)
}
