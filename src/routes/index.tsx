import { useState, useCallback, useEffect, useRef } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useAction, useQuery, useConvexAuth } from 'convex/react'
import { useAuthActions } from '@convex-dev/auth/react'
import { api } from '../../convex/_generated/api'
import { FrameContainer } from '../components/FrameContainer'
import { PromptInput } from '../components/PromptInput'
import TalkingHead, { type TalkingHeadHandle } from '../components/TalkingHead'

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
  const loadingRef = useRef(false)
  const threadRef = useRef<string | null>(null)
  const doneCountRef = useRef(0)
  const headRef = useRef<TalkingHeadHandle>(null)
  const spokenCountRef = useRef(0)
  const audioPlayedIds = useRef(new Set<string>())

  const createThread = useAction(api.chat.createNewThread)
  const sendMessage = useAction(api.chat.sendMessageStreaming)

  loadingRef.current = isLoading
  threadRef.current = threadId

  const explanations = useQuery(
    api.explanations.getByThread,
    threadId ? { threadId } : 'skip'
  )

  const doneCount = explanations?.filter((e) => e.skill === '_done').length ?? 0
  useEffect(() => {
    if (doneCount > doneCountRef.current) {
      setIsLoading(false)
    }
    doneCountRef.current = doneCount
  }, [doneCount])

  useEffect(() => {
    if (!explanations || !headRef.current) return

    const sorted = [...explanations].sort((a, b) => {
      const sa = a.step ?? Infinity
      const sb = b.step ?? Infinity
      if (sa !== sb) return sa - sb
      return a._creationTime - b._creationTime
    })

    const pendingIntro = sorted.find(
      (e) => e.skill === 'intro' && !audioPlayedIds.current.has(e._id)
    )
    const introReady = !pendingIntro || (pendingIntro.audioUrl && pendingIntro.audioTimings)

    for (const exp of sorted) {
      const id = exp._id
      if (exp.audioUrl && exp.audioTimings && !audioPlayedIds.current.has(id)) {
        if (exp.skill !== 'intro' && !introReady) break
        audioPlayedIds.current.add(id)
        headRef.current.speakWithAudio(exp.audioUrl, JSON.parse(exp.audioTimings))
      }
    }

    const newOnes = explanations.slice(spokenCountRef.current)
    spokenCountRef.current = explanations.length
    for (const exp of newOnes) {
      if (!exp.audioUrl && exp.narration) {
        headRef.current.speak(exp.narration)
      }
    }
  }, [explanations])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        headRef.current?.stopSpeaking()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleSubmit = useCallback(async (text: string) => {
    if (loadingRef.current) return
    setIsLoading(true)
    setErrorMsg(null)

    headRef.current?.warmUpAudio()
    headRef.current?.speak(text)

    try {
      let currentThreadId = threadRef.current
      if (!currentThreadId) {
        currentThreadId = await createThread({})
        setThreadId(currentThreadId)
      }
      sendMessage({ threadId: currentThreadId, prompt: text }).catch((err) => {
        console.error('Agent error:', err)
        setErrorMsg(humanizeError(err))
        setIsLoading(false)
      })
    } catch (err) {
      console.error('Failed to send message:', err)
      setErrorMsg(humanizeError(err))
      setIsLoading(false)
    }
  }, [createThread, sendMessage])

  const hasFrames = (explanations?.filter((e) => e.skill !== '_done').length ?? 0) > 0 || isLoading

  return (
    <div className="canvas">
      <button
        onClick={() => signOut()}
        className="fixed top-4 right-4 z-50 text-[10px] uppercase tracking-[0.24em] text-ash hover:text-crimson transition font-mono"
        aria-label="Sign out"
      >
        sign out
      </button>

      <div className={hasFrames ? 'talking-head-side' : 'talking-head-bg'}>
        <TalkingHead ref={headRef} />
      </div>

      <FrameContainer
        explanations={explanations ?? []}
        isLoading={isLoading}
        onAction={handleSubmit}
      />
      <PromptInput onSubmit={handleSubmit} isLoading={isLoading} />

      {errorMsg && (
        <div
          role="alert"
          className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-void/90 border border-crimson/60 text-bone text-[11px] font-mono uppercase tracking-[0.18em] px-4 py-2 rounded-sm backdrop-blur pulse-crimson"
        >
          {errorMsg}
        </div>
      )}
    </div>
  )
}

function humanizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/rate.?limit|too many/i.test(msg)) return "slow down — you're over the hourly limit"
  if (/not authenticated/i.test(msg)) return 'session expired — sign in again'
  if (/forbidden/i.test(msg)) return "that thread isn't yours"
  return 'something went wrong — try again'
}
