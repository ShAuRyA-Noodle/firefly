import { useState, useRef, useCallback, useEffect } from 'react'

const SpeechRecognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : undefined

export function useSpeechToText() {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const recognitionRef = useRef<InstanceType<NonNullable<typeof SpeechRecognition>> | null>(null)

  const isSupported = !!SpeechRecognition

  const startListening = useCallback(() => {
    if (!SpeechRecognition) return

    // If a recognition session is already in flight (user double-clicked the
    // mic, or startListening fired twice), abort it before constructing a
    // new instance. Without this, the browser leaks the previous session
    // and we end up with two engines fighting over the microphone.
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort()
      } catch {
        // abort() can throw if the recognizer was already torn down; safe
        // to ignore — we're about to drop the reference anyway.
      }
      recognitionRef.current = null
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onstart = () => {
      setIsListening(true)
      setTranscript('')
      setInterimTranscript('')
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = ''
      let interimText = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalText += result[0].transcript
        } else {
          interimText += result[0].transcript
        }
      }

      if (finalText) setTranscript(finalText)
      setInterimTranscript(interimText)
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('[STT] Recognition error:', event.error)
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
      setInterimTranscript('')
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
    }
  }, [])

  return {
    isListening,
    transcript,
    interimTranscript,
    startListening,
    stopListening,
    isSupported,
  }
}
