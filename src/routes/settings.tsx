import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useAction, useConvexAuth } from 'convex/react'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

function SettingsPage() {
  // Same hydration dance as me.tsx — useConvexAuth's first render is unreliable
  // during SSR-style hydration and we don't want to flash "loading" only to
  // immediately bounce to /signin.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <div className="canvas" />
  return <Gate />
}

function Gate() {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (!isLoading && !isAuthenticated) navigate({ to: '/signin' })
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
  return <Settings />
}

const VOICES = [
  { id: 'anushka', label: 'Anushka' },
  { id: 'manisha', label: 'Manisha' },
  { id: 'vidya', label: 'Vidya' },
  { id: 'arya', label: 'Arya' },
  { id: 'abhilash', label: 'Abhilash' },
  { id: 'karun', label: 'Karun' },
  { id: 'hitesh', label: 'Hitesh' },
] as const

const LANGUAGES = [
  { id: 'en-IN', label: 'English (India)' },
  { id: 'hi-IN', label: 'Hindi' },
  { id: 'bn-IN', label: 'Bengali' },
  { id: 'kn-IN', label: 'Kannada' },
  { id: 'ml-IN', label: 'Malayalam' },
  { id: 'mr-IN', label: 'Marathi' },
  { id: 'ta-IN', label: 'Tamil' },
  { id: 'te-IN', label: 'Telugu' },
  { id: 'gu-IN', label: 'Gujarati' },
  { id: 'pa-IN', label: 'Punjabi' },
  { id: 'od-IN', label: 'Odia' },
] as const

function Settings() {
  const prefs = useQuery(api.userPreferences.getMine, {})
  const setPrefs = useMutation(api.userPreferences.setMine)

  // Optimistic local state with `prefs` as source-of-truth on hydration.
  // Saving goes through setPrefs; we don't replay the server echo because
  // Convex's reactive queries push the update back automatically.
  const [voice, setVoice] = useState<string>('anushka')
  const [language, setLanguage] = useState<string>('en-IN')
  const [speed, setSpeed] = useState<number>(1.0)
  const [autoplay, setAutoplay] = useState<boolean>(true)
  const [reducedMotion, setReducedMotion] = useState<boolean>(false)
  const [savingMessage, setSavingMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Hydrate local state from server once prefs arrive. Subsequent reactive
  // updates (other devices saving) overwrite local state — settings is a
  // last-write-wins surface, and a flicker from a real cross-device update
  // is correct behaviour.
  useEffect(() => {
    if (!prefs) return
    if (prefs.voice) setVoice(prefs.voice)
    if (prefs.voiceLanguage) setLanguage(prefs.voiceLanguage)
    if (prefs.narrationSpeed != null) setSpeed(prefs.narrationSpeed)
    if (prefs.autoplay != null) setAutoplay(prefs.autoplay)
    if (prefs.reducedMotion != null) setReducedMotion(prefs.reducedMotion)
  }, [prefs?._id])

  async function save(patch: Parameters<typeof setPrefs>[0]) {
    setErrorMessage(null)
    setSavingMessage('saving...')
    try {
      await setPrefs(patch)
      setSavingMessage('saved')
      window.setTimeout(() => setSavingMessage(null), 1200)
    } catch (err) {
      setSavingMessage(null)
      setErrorMessage(err instanceof Error ? err.message : 'save failed')
    }
  }

  return (
    <div className="canvas px-6 py-12 max-w-3xl mx-auto">
      <header className="mb-12 flex items-end justify-between">
        <div>
          <p className="kicker text-crimson">your</p>
          <h1 className="display-title text-5xl text-bone">SETTINGS</h1>
        </div>
        <div className="flex items-center gap-4">
          <Link
            to="/me"
            className="text-[10px] uppercase tracking-[0.24em] text-ash hover:text-crimson transition font-mono"
          >
            learning
          </Link>
          <Link
            to="/"
            className="text-[10px] uppercase tracking-[0.24em] text-ash hover:text-crimson transition font-mono"
          >
            ← back
          </Link>
        </div>
      </header>

      <section className="mb-12 space-y-6" aria-labelledby="voice-heading">
        <div className="flex items-baseline justify-between">
          <h2 id="voice-heading" className="kicker text-ash">narration</h2>
          {savingMessage && (
            <span className="text-[10px] font-mono text-crimson uppercase tracking-[0.2em]" role="status">
              {savingMessage}
            </span>
          )}
        </div>

        <label className="block space-y-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-bone font-mono">
            voice
          </span>
          <select
            value={voice}
            onChange={(e) => {
              const v = e.target.value
              setVoice(v)
              save({ voice: v })
            }}
            className="input-bmth w-full min-h-[44px]"
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-bone font-mono">
            language
          </span>
          <select
            value={language}
            onChange={(e) => {
              const v = e.target.value
              setLanguage(v)
              save({ voiceLanguage: v })
            }}
            className="input-bmth w-full min-h-[44px]"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-bone font-mono">
            narration speed · <span className="text-ash">{speed.toFixed(2)}x</span>
          </span>
          <input
            type="range"
            min={0.5}
            max={2.0}
            step={0.05}
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            // Save on commit (release) rather than every input event — a
            // slider drag would otherwise fire dozens of mutations.
            onMouseUp={() => save({ narrationSpeed: speed })}
            onTouchEnd={() => save({ narrationSpeed: speed })}
            className="w-full accent-crimson min-h-[44px]"
          />
        </label>

        <label className="flex items-center gap-3 min-h-[44px]">
          <input
            type="checkbox"
            checked={autoplay}
            onChange={(e) => {
              const v = e.target.checked
              setAutoplay(v)
              save({ autoplay: v })
            }}
            className="accent-crimson w-5 h-5"
          />
          <span className="text-[11px] uppercase tracking-[0.18em] text-bone font-mono">
            autoplay narration
          </span>
        </label>
      </section>

      <section className="mb-12 space-y-6" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className="kicker text-ash">appearance</h2>
        <label className="block space-y-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-bone font-mono">
            theme
          </span>
          <select
            value="dark"
            disabled
            className="input-bmth w-full min-h-[44px] opacity-60 cursor-not-allowed"
            aria-describedby="theme-note"
          >
            <option value="dark">dark</option>
          </select>
          <span id="theme-note" className="text-[10px] font-mono text-smoke">
            light mode coming soon
          </span>
        </label>

        <label className="flex items-center gap-3 min-h-[44px]">
          <input
            type="checkbox"
            checked={reducedMotion}
            onChange={(e) => {
              const v = e.target.checked
              setReducedMotion(v)
              save({ reducedMotion: v })
            }}
            className="accent-crimson w-5 h-5"
          />
          <span className="text-[11px] uppercase tracking-[0.18em] text-bone font-mono">
            reduce motion
          </span>
        </label>
      </section>

      <AccountSection />

      {errorMessage && (
        <p role="alert" className="text-xs text-ember font-mono tracking-wide pt-4">
          {errorMessage}
        </p>
      )}
    </div>
  )
}

function AccountSection() {
  // api.users.exportMine + api.users.deleteMe come from Zeta — we
  // reference them defensively. If Zeta hasn't shipped yet, the function
  // refs may be undefined at runtime; we still call useAction/useMutation
  // unconditionally (Rules of Hooks) but pass through the maybe-undefined
  // ref. The button handlers gate on availability before invoking.
  // Once Zeta lands, no code change here is needed; the convex deploy
  // refresh wires the functions automatically.
  const usersApi: any = (api as any).users ?? {}
  const exportMineFn: any = usersApi.exportMine
  const deleteMeFn: any = usersApi.deleteMe

  // Hooks must be called unconditionally. When the function ref is
  // undefined the hook still runs but the returned callable will throw if
  // invoked — we guard call sites instead.
  const exportMine = useAction(exportMineFn)
  const deleteMe = useMutation(deleteMeFn)

  useEffect(() => {
    if (!exportMineFn || !deleteMeFn) {
      // eslint-disable-next-line no-console
      console.warn(
        '[settings] api.users.exportMine / deleteMe not yet deployed — buttons will be disabled until Zeta ships.',
      )
    }
  }, [exportMineFn, deleteMeFn])

  const [downloading, setDownloading] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function handleExport() {
    if (!exportMineFn) {
      setError('export not yet available')
      return
    }
    setDownloading(true)
    setError(null)
    try {
      const data: unknown = await exportMine({})
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `firefly-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'export failed')
    } finally {
      setDownloading(false)
    }
  }

  async function handleDelete() {
    if (!deleteMeFn) {
      setError('delete not yet available')
      return
    }
    if (confirmInput !== 'DELETE') return
    setDeleting(true)
    setError(null)
    try {
      await deleteMe({})
      // Bounce out — the server has tombstoned the account; ConvexAuth
      // will see the next query fail and surface the user as signed-out.
      navigate({ to: '/signin' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed')
      setDeleting(false)
    }
  }

  return (
    <section className="mb-12 space-y-6" aria-labelledby="account-heading">
      <h2 id="account-heading" className="kicker text-ash">account</h2>
      <div className="space-y-3">
        <button
          type="button"
          onClick={handleExport}
          disabled={downloading || !exportMineFn}
          className="btn-ghost w-full md:w-auto min-h-[44px]"
        >
          {downloading ? 'preparing...' : 'download my data'}
        </button>
        <button
          type="button"
          onClick={() => setShowDeleteModal(true)}
          disabled={!deleteMeFn}
          className="btn-ghost w-full md:w-auto min-h-[44px] text-ember hover:text-crimson"
        >
          delete account
        </button>
      </div>

      {showDeleteModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur px-4"
        >
          <div className="bg-void border border-crimson/40 rounded-sm p-6 max-w-sm w-full space-y-4">
            <h3 id="delete-confirm-heading" className="kicker text-crimson">
              delete account
            </h3>
            <p className="text-bone text-xs font-mono leading-relaxed">
              this is irreversible. all threads, frames, audio, memories, and
              skill progress will be erased. type <span className="text-crimson">DELETE</span> to confirm.
            </p>
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              className="input-bmth w-full min-h-[44px]"
              placeholder="DELETE"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false)
                  setConfirmInput('')
                }}
                disabled={deleting}
                className="btn-ghost flex-1 min-h-[44px]"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={confirmInput !== 'DELETE' || deleting}
                className="btn-crimson flex-1 min-h-[44px]"
              >
                {deleting ? '...' : 'delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-ember font-mono tracking-wide">
          {error}
        </p>
      )}
    </section>
  )
}
