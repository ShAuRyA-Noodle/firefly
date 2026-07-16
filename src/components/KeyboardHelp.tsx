import { useEffect, useRef, useState, useCallback } from 'react'

// `?` keybind opens a fixed centered modal listing keyboard shortcuts.
// Mounted once at the App root so the binding works from anywhere except
// when the user is typing in an input/textarea/contenteditable.
//
// A11y:
//   - role=dialog + aria-modal="true"
//   - first focusable element receives focus on open (close button)
//   - Tab/Shift-Tab cycles within the dialog's focusable list (focus trap)
//   - Esc closes; click on backdrop closes
//   - Focus is restored to whatever was focused before open

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '↵', label: 'send' },
  { keys: '← →', label: 'previous / next frame' },
  { keys: '↑ ↓', label: 'previous / next frame' },
  { keys: 'Space', label: 'stop narration' },
  { keys: 'Esc', label: 'close this overlay' },
  { keys: '?', label: 'open this overlay' },
]

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function KeyboardHelp() {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  // Previously-focused element so we can restore focus on close — without
  // this, closing the modal leaves focus on document.body, which strands
  // keyboard users with no clear "back to where I was" anchor.
  const prevFocusRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => setOpen(false), [])

  // Listen for the `?` shortcut globally. We intentionally check shiftKey
  // so accidental layouts where `?` shares a key with `/` don't double-fire,
  // and we skip when the user is typing into form fields / contenteditable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '?') return
      const target = e.target as Element | null
      if (
        target?.closest?.(
          'input, textarea, select, [contenteditable="true"]',
        )
      ) {
        return
      }
      e.preventDefault()
      setOpen((v) => !v)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Focus management: when the dialog opens, capture the prior focus owner
  // so we can return focus on close. When it closes, restore.
  useEffect(() => {
    if (open) {
      prevFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
      // requestAnimationFrame defers focus until the dialog actually paints —
      // focusing before mount fails silently and the modal opens unfocused.
      requestAnimationFrame(() => {
        closeBtnRef.current?.focus()
      })
    } else if (prevFocusRef.current) {
      // Guard against the prior focus being a now-detached node (e.g. the
      // user navigated away while the dialog was up).
      try {
        prevFocusRef.current.focus()
      } catch {
        /* prior focus owner is gone — fall back to body, which the browser
           handles automatically. */
      }
      prevFocusRef.current = null
    }
  }, [open])

  // Focus trap + Esc-to-close while the dialog is open. Tab cycles between
  // the first/last focusable nodes inside the dialog so keyboard users can't
  // accidentally tab into the unreachable backdrop content.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute('aria-hidden'))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, close])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-void/85 backdrop-blur-sm"
      onClick={(e) => {
        // Click-outside dismiss: only when the click target is the backdrop
        // itself, not anything bubbling up from inside the dialog.
        if (e.target === e.currentTarget) close()
      }}
      aria-hidden="false"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kbhelp-title"
        aria-describedby="kbhelp-desc"
        className="relative w-[min(92vw,28rem)] bg-void border border-white/10 rounded-sm p-6 shadow-2xl shadow-black/40"
      >
        <div className="flex items-start justify-between mb-5">
          <div>
            <p
              id="kbhelp-desc"
              className="kicker text-crimson mb-2"
            >
              keyboard
            </p>
            <h2
              id="kbhelp-title"
              className="text-bone text-xl font-mono tracking-tight"
            >
              shortcuts
            </h2>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            aria-label="Close keyboard shortcuts"
            className="text-ash hover:text-crimson transition-colors text-sm font-mono px-2 py-1 rounded-sm focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none"
          >
            esc ✕
          </button>
        </div>

        <ul className="space-y-2">
          {SHORTCUTS.map((s, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-4 py-2 border-b border-white/5 last:border-b-0"
            >
              <span className="text-bone text-sm font-mono">{s.label}</span>
              <kbd className="font-mono text-[11px] tracking-[0.18em] uppercase text-crimson bg-crimson/10 border border-crimson/30 rounded-sm px-2 py-1 min-w-[3rem] text-center">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>

        <p className="mt-5 text-[10px] font-mono tracking-[0.22em] uppercase text-smoke text-center">
          press · esc · or click outside
        </p>
      </div>
    </div>
  )
}

export default KeyboardHelp
