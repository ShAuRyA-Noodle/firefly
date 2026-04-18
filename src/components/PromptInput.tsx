import { useState, useRef, useEffect } from 'react'
import { Mic, MicOff } from 'lucide-react'
import { useSpeechToText } from '../hooks/useSpeechToText'

export function PromptInput({
  onSubmit,
  isLoading,
}: {
  onSubmit: (text: string) => void
  isLoading: boolean
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { isListening, transcript, interimTranscript, startListening, stopListening, isSupported } =
    useSpeechToText()

  // When speech recognition finalizes, put transcript in the input
  useEffect(() => {
    if (transcript) {
      setValue(transcript)
      inputRef.current?.focus()
    }
  }, [transcript])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = value.trim()
    if (!text || isLoading) return
    onSubmit(text)
    setValue('')
  }

  const handleMicClick = () => {
    if (isListening) {
      stopListening()
    } else {
      startListening()
    }
  }

  // Show interim transcript while listening
  const displayValue = isListening && interimTranscript ? interimTranscript : value

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 pb-6">
      <div className="mx-auto max-w-2xl">
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
              isListening ? 'listening…' : isLoading ? 'generating…' : 'ask anything'
            }
            disabled={isLoading}
            className="flex-1 bg-transparent text-bone placeholder:text-smoke text-sm font-mono outline-none disabled:opacity-50 tracking-wide"
            autoFocus
            aria-label="Your question"
          />
          {isSupported && (
            <button
              type="button"
              onClick={handleMicClick}
              disabled={isLoading}
              className="ml-3 flex h-8 w-8 items-center justify-center rounded-sm border border-white/5 hover:border-crimson/60 transition disabled:opacity-20"
              aria-label={isListening ? 'Stop listening' : 'Start voice input'}
            >
              {isListening ? (
                <Mic size={14} className="text-crimson pulse-crimson" />
              ) : (
                <MicOff size={14} className="text-ash hover:text-bone" />
              )}
            </button>
          )}
          <button
            type="submit"
            disabled={!displayValue.trim() || isLoading}
            className="ml-2 flex h-8 w-8 items-center justify-center rounded-sm bg-crimson text-bone transition hover:bg-crimson-bright disabled:opacity-20 disabled:bg-iron disabled:text-smoke"
            aria-label="Send"
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
          ↵ send · ← → scrub frames · space stops voice
        </p>
      </div>
    </div>
  )
}
