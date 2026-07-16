import { useState, useRef, useEffect, useCallback } from 'react'
import { Mic, Paperclip, X } from 'lucide-react'
import { useSpeechToText } from '../hooks/useSpeechToText'

const ACCEPTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const
const ACCEPT_ATTR = ACCEPTED_MIME_TYPES.join(',')
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB

function isAcceptedImage(file: File): boolean {
  // Browsers normally set file.type from the OS MIME-table, but pasted /
  // dropped files occasionally arrive with an empty type. Fall back to the
  // extension when type is missing — the server-side filter in
  // convex/vision.ts re-validates so a spoofed extension still gets caught.
  if (file.type) {
    return (ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type.toLowerCase())
  }
  const lower = file.name.toLowerCase()
  return /\.(png|jpe?g|webp|gif)$/i.test(lower)
}

export function PromptInput({
  onSubmit,
  onImageSubmit,
  isLoading,
}: {
  onSubmit: (text: string) => void
  onImageSubmit?: (file: File) => Promise<void>
  isLoading: boolean
}) {
  const [value, setValue] = useState('')
  const [pendingImage, setPendingImage] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { isListening, transcript, interimTranscript, startListening, stopListening, isSupported } =
    useSpeechToText()

  // When speech recognition finalizes, put transcript in the input
  useEffect(() => {
    if (transcript) {
      setValue(transcript)
      inputRef.current?.focus()
    }
  }, [transcript])

  // Prefill bridge: Onboarding (and any other surface) can request the
  // input populate by dispatching `firefly:prompt-prefill` with `detail.prompt`.
  // We also drain `localStorage["firefly.pendingPrompt"]` on mount so a
  // refresh mid-pick doesn't lose the choice. The localStorage key is
  // single-use — clearing on consume avoids re-applying it on later remount
  // (e.g. signing out/in).
  useEffect(() => {
    const apply = (text: string | null | undefined) => {
      if (!text) return
      setValue(text)
      // requestAnimationFrame so focus + caret-end land after the value
      // commits — focusing before paint can leave the caret at index 0.
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        try {
          el.setSelectionRange(text.length, text.length)
        } catch {
          /* setSelectionRange throws on some types; ignore. */
        }
      })
    }

    try {
      const pending = localStorage.getItem('firefly.pendingPrompt')
      if (pending) {
        localStorage.removeItem('firefly.pendingPrompt')
        apply(pending)
      }
    } catch {
      /* localStorage unavailable — event listener below still works */
    }

    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent<{ prompt?: string }>).detail
      apply(detail?.prompt)
      try {
        localStorage.removeItem('firefly.pendingPrompt')
      } catch {
        /* swallow — already applied in-memory */
      }
    }
    window.addEventListener('firefly:prompt-prefill', onPrefill as EventListener)
    return () =>
      window.removeEventListener('firefly:prompt-prefill', onPrefill as EventListener)
  }, [])

  // Object URLs leak memory if not revoked. Tie creation/cleanup to the
  // pendingImage lifecycle so cancel + re-pick don't strand blob: URLs.
  useEffect(() => {
    if (!pendingImage) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(pendingImage)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pendingImage])

  const acceptFile = useCallback((file: File) => {
    setImageError(null)
    if (!isAcceptedImage(file)) {
      setImageError('only PNG, JPEG, WEBP, or GIF')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1)
      setImageError(`image too large — ${mb} MB (max 10)`)
      return
    }
    if (file.size === 0) {
      setImageError('image is empty')
      return
    }
    setPendingImage(file)
  }, [])

  // Window-level drag tracking so the visual overlay shows ONLY when a real
  // file is being dragged into the page (not when dragging text or DOM
  // elements). dragenter/dragleave fire many times as the cursor crosses
  // child boundaries — a counter is the standard fix.
  useEffect(() => {
    if (!onImageSubmit) return
    let depth = 0
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setIsDraggingFile(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setIsDraggingFile(false)
    }
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setIsDraggingFile(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) acceptFile(file)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [acceptFile, onImageSubmit])

  // Cmd/Ctrl-V paste — pull image data out of the clipboard. Skip if
  // a text selection is being pasted (item.kind === 'string'). The
  // input field's onPaste would also see this, but a window-level
  // listener catches paste even when no input is focused.
  useEffect(() => {
    if (!onImageSubmit) return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            acceptFile(file)
            return
          }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [acceptFile, onImageSubmit])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (isLoading) return

    if (pendingImage && onImageSubmit) {
      // Image takes precedence — text + image is ambiguous so we just send
      // the image. The pending file is cleared on success by the caller's
      // re-render path (loading → idle); we clear locally too in case the
      // promise rejects so the user can re-try cleanly.
      const file = pendingImage
      void onImageSubmit(file).finally(() => {
        setPendingImage(null)
        setValue('')
      })
      return
    }

    const text = value.trim()
    if (!text) return
    onSubmit(text)
    setValue('')
    // Release focus so the advertised "← → scrub frames" shortcut actually
    // works right after asking. While the input kept focus, the frame
    // container's key handler bailed out (it ignores events from inputs) and
    // the arrows silently did nothing. Click the bar to type again.
    inputRef.current?.blur()
  }

  const handleMicClick = () => {
    if (isListening) {
      stopListening()
    } else {
      startListening()
    }
  }

  const handleFilePick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) acceptFile(file)
    // Reset so picking the same file twice still triggers onChange.
    e.target.value = ''
  }

  const cancelImage = () => {
    setPendingImage(null)
    setImageError(null)
  }

  // Show interim transcript while listening
  const displayValue = isListening && interimTranscript ? interimTranscript : value

  const submitDisabled =
    isLoading || (!pendingImage && !displayValue.trim())

  return (
    <>
      {isDraggingFile && (
        <div
          aria-hidden
          className="fixed inset-0 z-[60] pointer-events-none flex items-center justify-center bg-void/70 backdrop-blur"
        >
          <div className="border-2 border-dashed border-crimson rounded-sm px-12 py-10 text-center">
            <div className="text-crimson font-mono text-sm tracking-[0.32em] uppercase">
              drop to ask
            </div>
            <div className="mt-2 text-smoke font-mono text-[10px] tracking-[0.24em] uppercase">
              png · jpeg · webp · gif · max 10 mb
            </div>
          </div>
        </div>
      )}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 p-4"
        style={{ paddingBottom: 'max(1.5rem, calc(0.5rem + env(safe-area-inset-bottom)))' }}
      >
        <div className="mx-auto max-w-2xl">
          {pendingImage && previewUrl && (
            <div className="mb-2 flex items-center gap-3 glass-input rounded-sm px-3 py-2">
              <img
                src={previewUrl}
                alt="pending upload"
                className="h-12 w-12 rounded-sm object-cover border border-white/10"
              />
              <div className="flex-1 min-w-0">
                <div className="text-bone font-mono text-[11px] truncate">
                  {pendingImage.name || 'pasted image'}
                </div>
                <div className="text-smoke font-mono text-[10px] tracking-[0.18em] uppercase">
                  {(pendingImage.size / 1024).toFixed(1)} kb · ready to send
                </div>
              </div>
              <button
                type="button"
                onClick={cancelImage}
                className="flex h-7 w-7 items-center justify-center rounded-sm border border-white/5 hover:border-crimson/60 transition"
                aria-label="Remove image"
              >
                <X size={12} className="text-ash" />
              </button>
            </div>
          )}
          {imageError && (
            <div
              role="alert"
              className="mb-2 text-center font-mono text-[10px] tracking-[0.22em] uppercase text-crimson"
            >
              {imageError}
            </div>
          )}
          <form
            onSubmit={handleSubmit}
            className="glass-input rounded-sm flex items-center px-4 py-3"
            aria-label="Ask Firefly"
          >
            <span className="text-crimson font-mono text-sm mr-2 select-none" aria-hidden>
              /
            </span>
            <input
              ref={inputRef}
              type="text"
              value={displayValue}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                pendingImage
                  ? 'press send to extract question from image'
                  : isListening
                    ? 'listening…'
                    : isLoading
                      ? 'generating…'
                      : 'ask anything · drop or paste an image'
              }
              disabled={isLoading}
              className="flex-1 bg-transparent text-bone placeholder:text-smoke text-sm font-mono outline-none disabled:opacity-50 tracking-wide"
              autoFocus
              aria-label="Your question"
            />
            {onImageSubmit && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_ATTR}
                  onChange={handleFileChange}
                  className="hidden"
                  aria-hidden
                  tabIndex={-1}
                />
                <button
                  type="button"
                  onClick={handleFilePick}
                  disabled={isLoading}
                  className="ml-2 flex h-8 w-8 items-center justify-center rounded-sm border border-white/5 hover:border-crimson/60 transition disabled:opacity-20"
                  aria-label="Attach image"
                >
                  <Paperclip size={14} className="text-ash hover:text-bone" />
                </button>
              </>
            )}
            {isSupported && (
              <button
                type="button"
                onClick={handleMicClick}
                disabled={isLoading}
                className="ml-2 flex h-8 w-8 items-center justify-center rounded-sm border border-white/5 hover:border-crimson/60 transition disabled:opacity-20"
                aria-label={isListening ? 'Stop listening' : 'Start voice input'}
              >
                {/* Mic icon in both states — idle reads as "voice available",
                    listening lights it crimson + pulses. (A MicOff-when-idle
                    icon wrongly reads as "microphone disabled".) */}
                <Mic
                  size={14}
                  className={
                    isListening
                      ? 'text-crimson pulse-crimson'
                      : 'text-ash hover:text-bone'
                  }
                />
              </button>
            )}
            <button
              type="submit"
              disabled={submitDisabled}
              className="ml-2 flex h-8 w-8 items-center justify-center rounded-sm bg-crimson text-bone transition hover:bg-crimson-bright disabled:opacity-20 disabled:bg-iron disabled:text-smoke"
              aria-label={pendingImage ? 'Send image' : 'Send'}
            >
              {isLoading ? (
                <span className="loading-breathe text-[10px] tracking-[0.24em]">...</span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M3 8h10M9 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </form>
          <p className="mt-2 text-center text-[10px] font-mono text-smoke tracking-[0.22em] uppercase">
            ↵ send · ← → scrub frames · space stops voice · drop / paste image
          </p>
        </div>
      </div>
    </>
  )
}
