/**
 * TalkingHead — Crimson Skeleton.
 *
 * Two-pass render (borrowed from the original proven approach, upgraded):
 *   1. Dark solid skin with crimson fresnel rim glow → silhouette that breathes
 *   2. Crimson wireframe overlay (additive) → topology you can see, no cage
 *   3. Particle aura (amber → crimson, additive) → magical ambience
 *   4. Cinematic 3-point rig (crimson key, cool fill, warm rim)
 *   5. Voice-reactive uniforms driving emissive + bloom feel
 *
 * Zero CSS radial gradients on the background — pure black. Any "glow" is
 * shader-driven so it reads as real light, not a filter blob.
 *
 * Resource lifecycle: every GPU/audio handle allocated by this component is
 * tracked via a ref and disposed in the cleanup return. Chrome caps ~6
 * AudioContexts per origin and Three.js will leak shader programs forever
 * if ShaderMaterial.dispose isn't called — both matter on remount.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export interface AudioTimings {
  words: string[]
  wtimes: number[]
  wdurations: number[]
}

export type AvatarMood = 'idle' | 'thinking' | 'explaining' | 'confused' | 'happy'

export interface TalkingHeadHandle {
  speak: (text: string) => void
  speakWithAudio: (audioUrl: string, timings: AudioTimings) => void
  /** Queue an audio segment — plays after current clip finishes. */
  queueAudio: (audioUrl: string, timings: AudioTimings) => void
  stopSpeaking: () => void
  /** Pause: stops the current clip and the rest of the queue stays parked. */
  pause: () => void
  /** Resume: replays the current clip from the start (the underlying library
   *  doesn't support mid-buffer pause/resume — see comment in impl). */
  resume: () => void
  warmUpAudio: () => void
  setMood: (mood: AvatarMood) => void
}

const AVATAR_URL = '/avatars/avatarsdk.glb'

// Audio queue caps. Memory-bounded to survive rapid pause/resume storms and
// runaway producer loops without OOM.
const AUDIO_CACHE_MAX = 8
const AUDIO_QUEUE_MAX = 32

// ────────────────────────────────────────────────────────────────
// Skin pass: very dark base with crimson rim. Tuned so the figure is
// mostly silhouette, emerging from black only at its edges.
// ────────────────────────────────────────────────────────────────
const SKIN_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;

  #ifdef USE_SKINNING
    #include <skinning_pars_vertex>
  #endif
  #ifdef USE_MORPHTARGETS
    #include <morphtarget_pars_vertex>
  #endif

  void main() {
    #include <beginnormal_vertex>
    #ifdef USE_MORPHTARGETS
      #include <morphnormal_vertex>
    #endif
    #ifdef USE_SKINNING
      #include <skinbase_vertex>
      #include <skinnormal_vertex>
    #endif
    #include <defaultnormal_vertex>

    #include <begin_vertex>
    #ifdef USE_MORPHTARGETS
      #include <morphtarget_vertex>
    #endif
    #ifdef USE_SKINNING
      #include <skinning_vertex>
    #endif

    vec4 mvPos = viewMatrix * modelMatrix * vec4(transformed, 1.0);
    vNormal  = normalize(normalMatrix * objectNormal);
    vViewPos = -mvPos.xyz;

    gl_Position = projectionMatrix * mvPos;
  }
`

const SKIN_FRAG = /* glsl */ `
  precision highp float;

  varying vec3 vNormal;
  varying vec3 vViewPos;

  uniform vec3  uBase;      // very dark — almost black
  uniform vec3  uRim;       // crimson
  uniform float uRimPower;
  uniform float uRimGain;
  uniform float uAudio;     // 0..1
  uniform float uTime;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewPos);

    float wrap = clamp(dot(N, normalize(vec3(0.3, 0.6, 0.8))) * 0.5 + 0.5, 0.0, 1.0);
    vec3  base = uBase * (0.2 + 0.4 * wrap);

    float fres = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
    // Breath pulse while idle, big surge while speaking
    float pulse = 0.85 + 0.15 * sin(uTime * 0.7);
    vec3 rim = uRim * fres * (uRimGain * pulse + uAudio * 2.2);

    vec3 color = base + rim;

    // Cheap filmic-ish curve so the rim doesn't clip to white
    color = color / (color + vec3(0.55));
    color = pow(color, vec3(1.0 / 2.2));

    gl_FragColor = vec4(color, 1.0);
  }
`

// ────────────────────────────────────────────────────────────────
// Wireframe pass: thin crimson lines, additive. Alpha-modulated by
// fresnel so back-facing triangles fade instead of forming a cage.
// ────────────────────────────────────────────────────────────────
const WIRE_VERT = SKIN_VERT

const WIRE_FRAG = /* glsl */ `
  precision highp float;

  varying vec3 vNormal;
  varying vec3 vViewPos;

  uniform vec3  uColor;
  uniform float uAudio;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewPos);
    // Fresnel weight — edges brighter, back-facing wire dimmer.
    float f = pow(max(dot(N, V), 0.0), 0.7);
    // Dimmer base with a stronger edge falloff: the wire reads as a sculpted
    // contour rather than a solid red mesh, so the gold fireflies carry the
    // frame. Speech still lights it up via uAudio.
    float alpha = (0.10 + 0.40 * f) + uAudio * 0.40;
    gl_FragColor = vec4(uColor * (1.0 + uAudio * 1.1), alpha);
  }
`

type UniformsBag = {
  skin: Record<string, { value: any }>
  wire: Record<string, { value: any }>
  aura: Record<string, { value: any }>
}

function buildSkinMaterial(THREE: typeof import('three'), uniformsOut: { current: UniformsBag | null }) {
  const skin = {
    uBase:     { value: new THREE.Color('#0E0908') },
    // Warmer, softer rim — pulls the figure toward the firefly palette instead
    // of a hard crimson outline.
    uRim:      { value: new THREE.Color('#FF5A3C') },
    uRimPower: { value: 3.0 },
    uRimGain:  { value: 0.85 },
    uAudio:    { value: 0 },
    uTime:     { value: 0 },
  }
  const mat = new THREE.ShaderMaterial({
    vertexShader:   SKIN_VERT,
    fragmentShader: SKIN_FRAG,
    uniforms:       skin,
    side:           THREE.FrontSide,
  })
  ;(mat as any).skinning     = true
  ;(mat as any).morphTargets = true

  uniformsOut.current = {
    skin,
    wire: {
      // Deep ember instead of #FF2A36 — additive blending amplified the bright
      // red into a solid glowing mass; this keeps the mesh legible but quiet.
      uColor: { value: new THREE.Color('#9E1F1C') },
      uAudio: skin.uAudio,
    },
    aura: {
      uTime:  { value: 0 },
      uAudio: skin.uAudio,
    },
  }
  return mat
}

function buildWireMaterial(THREE: typeof import('three'), bag: UniformsBag) {
  const mat = new THREE.ShaderMaterial({
    vertexShader:   WIRE_VERT,
    fragmentShader: WIRE_FRAG,
    uniforms:       bag.wire,
    wireframe:      true,
    transparent:    true,
    depthWrite:     false,
    depthTest:      true,
    blending:       THREE.AdditiveBlending,
    side:           THREE.FrontSide,
  })
  ;(mat as any).skinning     = true
  ;(mat as any).morphTargets = true
  return mat
}

// Map our app-level moods onto the library's internal mood vocabulary plus
// our shader-driven extras (crimson pulse intensity, idle sway amplitude).
const MOOD_TO_LIBRARY: Record<AvatarMood, string> = {
  idle: 'neutral',
  thinking: 'neutral',
  explaining: 'happy',
  confused: 'sad',
  happy: 'happy',
}

const TalkingHeadComponent = forwardRef<TalkingHeadHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headRef = useRef<any>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const uniformsRef = useRef<UniformsBag | null>(null)
  const rafRef = useRef<number | null>(null)
  // GPU resources tracked for explicit dispose on unmount. Three.js never
  // GCs ShaderMaterial / BufferGeometry — they hold WebGL program/buffer
  // handles and leak forever otherwise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skinMatRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wireMatRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const partGeoRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const partMatRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const particlesRef = useRef<any>(null)
  // Wireframe clones we added to the scene. Each has its own cloned
  // BufferGeometry; the shared wireMat is disposed once above.
  const wireClonesRef = useRef<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Array<{ mesh: any; geometry: any; parent: any }>
  >([])
  // Reduced motion preference. Polled at init and updated live via a
  // matchMedia change listener; the RAF tick reads this on every frame.
  const reducedMotionRef = useRef(false)
  // Serial playback queue. speakWithAudio and queueAudio append; the
  // runner awaits each clip's duration before playing the next. Keeps
  // parallel-arriving frames from stomping each other's audio.
  const audioQueueRef = useRef<Array<{ url: string; timings: AudioTimings }>>([])
  const playingRef = useRef(false)
  // Tracks the clip we just started — pause() stashes it back at the head
  // of the queue so resume() replays the same one. The library decodes
  // each AudioBuffer fresh per call, so "pause" is honestly a "stop +
  // queue same clip again". Word-perfect mid-buffer resume would require
  // bypassing the talkinghead lipsync pipeline; not worth the reimpl.
  const lastStartedRef = useRef<{ url: string; timings: AudioTimings } | null>(null)
  const pausedRef = useRef(false)
  // LRU cache of fetched audio bytes keyed by URL. A rapid pause/resume
  // cycle would otherwise re-fetch the same blob from origin every loop.
  // Map preserves insertion order so eviction is O(1) at the head.
  const audioCacheRef = useRef<Map<string, ArrayBuffer>>(new Map())

  function getAudioContext(): AudioContext {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
    if (audioCtxRef.current.state === 'suspended') void audioCtxRef.current.resume()
    if (headRef.current?.audioCtx?.state === 'suspended') void headRef.current.audioCtx.resume()
    return audioCtxRef.current
  }

  const drainQueue = async () => {
    if (playingRef.current) return
    if (pausedRef.current) return
    if (!headRef.current) return
    // Memory cap: drop oldest queued items if a runaway producer floods us.
    while (audioQueueRef.current.length > AUDIO_QUEUE_MAX) {
      audioQueueRef.current.shift()
    }
    const next = audioQueueRef.current.shift()
    if (!next) return
    lastStartedRef.current = next
    playingRef.current = true
    try {
      const audioCtx = getAudioContext()

      // LRU cache: reuse decoded bytes if we already fetched this URL. The
      // ArrayBuffer is consumed by decodeAudioData (transferred internally
      // in some impls) so we slice() to get a fresh copy each replay.
      let arrayBuffer: ArrayBuffer
      const cached = audioCacheRef.current.get(next.url)
      if (cached) {
        // Refresh LRU position: delete + re-set moves to insertion tail.
        audioCacheRef.current.delete(next.url)
        audioCacheRef.current.set(next.url, cached)
        arrayBuffer = cached.slice(0)
      } else {
        const response = await fetch(next.url)
        arrayBuffer = await response.arrayBuffer()
        // Store a fresh copy of the bytes; we hand decodeAudioData another.
        audioCacheRef.current.set(next.url, arrayBuffer.slice(0))
        // LRU eviction: drop oldest entry once we exceed cap.
        while (audioCacheRef.current.size > AUDIO_CACHE_MAX) {
          const oldestKey = audioCacheRef.current.keys().next().value
          if (oldestKey === undefined) break
          audioCacheRef.current.delete(oldestKey)
        }
      }
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)

      if (!analyserRef.current && headRef.current.audioCtx) {
        const analyser = headRef.current.audioCtx.createAnalyser()
        analyser.fftSize = 128
        analyser.smoothingTimeConstant = 0.78
        if (headRef.current.audioGain) headRef.current.audioGain.connect(analyser)
        analyserRef.current = analyser
      }

      // Kill any stray browser-speech before real audio starts — never two
      // voices at once.
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
      headRef.current.setMood(MOOD_TO_LIBRARY['explaining'])
      headRef.current.speakAudio(
        {
          audio: audioBuffer,
          words: next.timings.words,
          wtimes: next.timings.wtimes,
          wdurations: next.timings.wdurations,
          visemes: [],
        },
        {},
        undefined,
      )

      const last = next.timings.wtimes.at(-1) ?? 0
      const lastDur = next.timings.wdurations.at(-1) ?? 0
      const durationMs = last + lastDur
      await new Promise<void>((resolve) => setTimeout(resolve, durationMs + 200))
    } catch (err) {
      console.error('[TalkingHead] queued playback failed:', err)
    } finally {
      playingRef.current = false
      // Chain onto the next clip if one was queued while this played.
      if (audioQueueRef.current.length > 0) void drainQueue()
      else {
        headRef.current?.setMood(MOOD_TO_LIBRARY['idle'])
        if (uniformsRef.current) uniformsRef.current.skin.uAudio.value = 0
      }
    }
  }

  useImperativeHandle(ref, () => ({
    speak(text: string) {
      // Free browser-TTS fallback for when the audio path isn't ready yet
      // (first frame, or the TTS provider is slow/down). The library's
      // speakText() targets an external Google-TTS endpoint we don't configure
      // — it fetched the app root and threw JSON-parse errors on every call.
      // The Web Speech API is free, needs no key, and speaks with real
      // pronunciation. (Phoneme-accurate lip-sync comes from the audio path:
      // speakAudio + word timings.)
      if (!text?.trim()) return
      try {
        const synth =
          typeof window !== 'undefined' ? window.speechSynthesis : null
        if (!synth) return
        headRef.current?.setMood(MOOD_TO_LIBRARY['explaining'])
        const u = new SpeechSynthesisUtterance(text)
        u.rate = 1.0
        u.pitch = 1.0
        u.onend = () => headRef.current?.setMood(MOOD_TO_LIBRARY['idle'])
        synth.cancel()
        synth.speak(u)
      } catch (err) {
        console.warn('[TalkingHead] speechSynthesis fallback failed:', err)
      }
    },
    warmUpAudio() {
      getAudioContext()
      if (headRef.current?.audioCtx?.state === 'suspended') void headRef.current.audioCtx.resume()
    },
    stopSpeaking() {
      headRef.current?.stopSpeaking()
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
      headRef.current?.setMood(MOOD_TO_LIBRARY['idle'])
      audioQueueRef.current = []
      playingRef.current = false
      pausedRef.current = false
      lastStartedRef.current = null
      if (uniformsRef.current) uniformsRef.current.skin.uAudio.value = 0
    },
    pause() {
      headRef.current?.stopSpeaking()
      pausedRef.current = true
      // Re-queue the clip we were on so resume() picks up at frame boundary.
      if (lastStartedRef.current) {
        audioQueueRef.current.unshift(lastStartedRef.current)
      }
      playingRef.current = false
      headRef.current?.setMood(MOOD_TO_LIBRARY['idle'])
      if (uniformsRef.current) uniformsRef.current.skin.uAudio.value = 0
    },
    resume() {
      pausedRef.current = false
      void drainQueue()
    },
    setMood(mood) {
      if (!headRef.current) return
      try {
        headRef.current.setMood(MOOD_TO_LIBRARY[mood])
      } catch (err) {
        console.warn('[TalkingHead] setMood failed:', err)
      }
    },
    speakWithAudio(audioUrl, timings) {
      // Legacy single-shot — now implemented as "clear queue + enqueue".
      audioQueueRef.current = [{ url: audioUrl, timings }]
      playingRef.current = false
      void drainQueue()
    },
    queueAudio(audioUrl, timings) {
      audioQueueRef.current.push({ url: audioUrl, timings })
      // Memory cap: cull oldest if producer is faster than consumer.
      while (audioQueueRef.current.length > AUDIO_QUEUE_MAX) {
        audioQueueRef.current.shift()
      }
      void drainQueue()
    },
  }))

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    let cancelled = false

    // ── Reduced-motion media query ──
    // Hoisted into the effect closure so cleanup can detach the change listener.
    const motionMQ =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
    reducedMotionRef.current = motionMQ?.matches ?? false
    const onMotionChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches
    }
    motionMQ?.addEventListener?.('change', onMotionChange)

    // ── Document-level audio resume listeners ──
    // Hoisted out of the async IIFE so the cleanup can remove them whether
    // or not init completed. The handler still self-removes on first
    // invocation as an optimization for the happy path.
    const resumeAudio = () => {
      if (headRef.current?.audioCtx?.state === 'suspended') {
        void headRef.current.audioCtx.resume()
      }
      document.removeEventListener('click', resumeAudio)
      document.removeEventListener('touchstart', resumeAudio)
      document.removeEventListener('keydown', resumeAudio)
    }
    document.addEventListener('click', resumeAudio)
    document.addEventListener('touchstart', resumeAudio)
    document.addEventListener('keydown', resumeAudio)

    ;(async () => {
      try {
        const [{ TalkingHead }, THREE] = await Promise.all([
          import('@met4citizen/talkinghead'),
          import('three'),
        ])
        if (cancelled) return

        const reduceMotion = reducedMotionRef.current

        const head = new TalkingHead(container, {
          cameraView:  'head',
          cameraRotateEnable: false,
          // Load the English lipsync module. Empty [] disabled it, which made
          // speakText()/viseme generation throw "Cannot read properties of
          // undefined (reading 'preProcessText')" on every narration — the
          // avatar never moved its mouth. 'en' loads modules/lipsync-en.mjs.
          lipsyncModules: ['en'],
          lipsyncLang: 'en',
          avatarMood:  'neutral',
          // Reduced-motion: zero out the library's idle motion knobs so the
          // head doesn't sway/blink/saccade beyond what's strictly needed
          // for the speaking lipsync itself.
          avatarIdleEyeContact:  reduceMotion ? 0 : 0.7,
          avatarIdleHeadMove:    reduceMotion ? 0 : 0.5,
          avatarSpeakingEyeContact: reduceMotion ? 0 : 0.8,
          avatarSpeakingHeadMove:   reduceMotion ? 0 : 0.7,
        })

        await head.showAvatar(
          { url: AVATAR_URL, lipsyncLang: 'en' },
          (e: { lengthComputable: boolean; loaded: number; total: number }) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100)
              const el = container.querySelector<HTMLElement>('[data-loading]')
              if (el) el.textContent = `igniting · ${pct}%`
            }
          },
        )
        if (cancelled) return

        // ── Build materials + swap ──
        const skinMat = buildSkinMaterial(THREE, uniformsRef)
        const wireMat = buildWireMaterial(THREE, uniformsRef.current!)
        skinMatRef.current = skinMat
        wireMatRef.current = wireMat

        const morphPairs: Array<{ original: any; clone: any }> = []
        const clonesToAdd: Array<{ clone: any; parent: any }> = []

        head.armature.traverse((child: any) => {
          if (!child.isMesh) return
          // Pass 1: dark skin on the original
          child.material = skinMat
          child.renderOrder = 0
          child.castShadow = false
          child.receiveShadow = false

          // Pass 2: wireframe clone, additive blended on top
          const wireClone = child.clone()
          wireClone.material = wireMat
          wireClone.renderOrder = 1
          if (child.isSkinnedMesh) {
            wireClone.bind(child.skeleton, child.bindMatrix.clone())
          }
          clonesToAdd.push({ clone: wireClone, parent: child.parent })

          if (child.morphTargetInfluences?.length) {
            morphPairs.push({ original: child, clone: wireClone })
          }
        })
        clonesToAdd.forEach(({ clone, parent }) => parent.add(clone))
        // Track for dispose. mesh.clone() shares geometry with the source by
        // default in three.js — but skinned-mesh clones produce their own
        // attribute buffers in some library versions. Dispose defensively:
        // dispose() on a shared geo is a no-op once the GPU resource has
        // already been freed, so it's safe either way.
        wireClonesRef.current = clonesToAdd.map(({ clone, parent }) => ({
          mesh: clone,
          geometry: clone.geometry,
          parent,
        }))

        // Dampen any default lights the library added
        head.scene.traverse((obj: any) => {
          if (obj.isLight) obj.intensity *= 0.25
        })

        // ── Cinematic 3-point rig ──
        // Softened from a red blast to a warmer, calmer key + amber rim so the
        // avatar reads as an elegant glowing figure among fireflies rather than
        // a harsh crimson silhouette.
        const key  = new THREE.DirectionalLight(0xff3d2e, 1.05)
        key.position.set(-1.2, 1.5, 1.4)
        const fill = new THREE.DirectionalLight(0x6688bb, 0.28)
        fill.position.set(1.3, 0.7, 0.9)
        const rim  = new THREE.DirectionalLight(0xffb066, 0.55)
        rim.position.set(0.15, 1.1, -2.1)
        const ambient = new THREE.AmbientLight(0x140808, 0.45)
        head.scene.add(key, fill, rim, ambient)

        // ── Firefly aura ──
        // Sparse, wide, wandering motes that read as individual fireflies
        // drifting around the avatar — not a dense glowing fog. On-brand:
        // firefly is the product's namesake.
        const PARTICLE_COUNT = 460
        const positions = new Float32Array(PARTICLE_COUNT * 3)
        const seeds     = new Float32Array(PARTICLE_COUNT)
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          const theta = Math.random() * Math.PI * 2
          const r     = 0.75 + Math.random() * 1.75  // wide horizontal spread
          const rad   = 0.55 + 0.45 * Math.random()
          positions[i * 3 + 0] = Math.cos(theta) * r * rad
          // Tall column around the head (head sits ~y=1.55).
          positions[i * 3 + 1] = 1.55 + (Math.random() - 0.35) * 2.4
          positions[i * 3 + 2] = Math.sin(theta) * r * rad
          seeds[i] = Math.random()
        }
        const partGeo = new THREE.BufferGeometry()
        partGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        partGeo.setAttribute('aSeed',    new THREE.BufferAttribute(seeds, 1))

        const partMat = new THREE.ShaderMaterial({
          uniforms: uniformsRef.current!.aura,
          vertexShader: /* glsl */ `
            attribute float aSeed;
            uniform float uTime;
            uniform float uAudio;
            varying float vAlpha;
            void main() {
              vec3 p = position;
              // Slow, individual wandering — each firefly drifts its own path.
              float t = uTime * (0.12 + aSeed * 0.3);
              p.x += sin(t + aSeed * 6.28) * 0.14;
              p.y += cos(t * 0.8 + aSeed * 4.0) * 0.11;
              p.z += sin(t * 0.6 + aSeed * 2.0) * 0.13;
              vec4 mv = modelViewMatrix * vec4(p, 1.0);
              gl_Position = projectionMatrix * mv;
              gl_PointSize = (1.0 + aSeed * 2.6 + uAudio * 1.8) * (200.0 / -mv.z);
              // Sparse twinkle — pow() keeps most fireflies dim with the
              // occasional bright flare, so they blink like real fireflies
              // instead of merging into a steady glowing fog.
              float pulse = 0.5 + 0.5 * sin(uTime * (0.8 + aSeed * 1.6) + aSeed * 20.0);
              vAlpha = pow(pulse, 3.0) * (0.35 + 0.65 * aSeed) + uAudio * 0.25;
            }
          `,
          fragmentShader: /* glsl */ `
            precision highp float;
            varying float vAlpha;
            void main() {
              vec2 uv = gl_PointCoord - 0.5;
              float d = length(uv);
              if (d > 0.5) discard;
              // Hot compact core + a fast-falling halo. A linear smoothstep
              // over the whole sprite made every mote a soft blob; squaring the
              // falloff gives a crisp firefly point with a subtle bloom.
              float halo = smoothstep(0.5, 0.0, d);
              float core = smoothstep(0.22, 0.0, d);
              float a = (halo * halo * 0.55 + core * 0.75) * vAlpha;
              // Warm firefly gold core → amber edge (not aggressive red).
              vec3 cCore = vec3(1.0, 0.93, 0.62);
              vec3 cEdge = vec3(0.95, 0.55, 0.14);
              vec3 col = mix(cCore, cEdge, smoothstep(0.0, 0.45, d));
              gl_FragColor = vec4(col, a);
            }
          `,
          transparent: true,
          depthWrite:  false,
          blending:    THREE.AdditiveBlending,
        })
        const particles = new THREE.Points(partGeo, partMat)
        head.scene.add(particles)
        partGeoRef.current = partGeo
        partMatRef.current = partMat
        particlesRef.current = particles

        // ── Uniform updater + morph sync ──
        const amps = new Uint8Array(64)
        const clock = new THREE.Clock()
        // Reduced-motion: write uTime once so the rim pulse and aura motion
        // are computed against a fixed t. We still run the RAF tick because
        // the talkinghead library renders the actual avatar inside its own
        // animate loop; we only suppress *our* shader animation.
        let firstFrameWritten = false

        function syncMorphs() {
          for (const { original, clone } of morphPairs) {
            if (original.morphTargetInfluences && clone.morphTargetInfluences) {
              for (let i = 0; i < original.morphTargetInfluences.length; i++) {
                clone.morphTargetInfluences[i] = original.morphTargetInfluences[i]
              }
            }
          }
        }

        function tick() {
          if (cancelled) return
          const reduce = reducedMotionRef.current
          const t = clock.getElapsedTime()
          const u = uniformsRef.current
          if (u) {
            if (!reduce || !firstFrameWritten) {
              u.skin.uTime.value = t
              u.aura.uTime.value = reduce ? 0 : t
              firstFrameWritten = true
            }

            let amp = 0
            const analyser = analyserRef.current
            if (analyser) {
              analyser.getByteFrequencyData(amps)
              let s = 0
              for (let i = 0; i < amps.length; i++) s += amps[i]
              amp = Math.min(1, s / (amps.length * 210))
            }
            const cur = u.skin.uAudio.value as number
            // Audio-reactive uniform always tracks voice — even with reduced
            // motion we want the rim to pulse on speech (it conveys "the
            // character is talking"). The per-frame *idle* sway is what we
            // suppress, not speech feedback.
            u.skin.uAudio.value = cur + (amp - cur) * 0.28
          }
          syncMorphs()

          // subtle cinematic sway — disabled under reduced motion
          if (head.camera && !reduce) {
            head.camera.position.x = Math.sin(t * 0.16) * 0.028
            head.camera.position.y = 1.65 + Math.sin(t * 0.21) * 0.014
          }
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)

        head.renderer.setClearColor(0x000000, 1)

        const overlay = container.querySelector<HTMLElement>('[data-loading]')
        if (overlay) overlay.style.display = 'none'

        headRef.current = head
      } catch (err) {
        console.error('[TalkingHead] init failed:', err)
        const el = container.querySelector<HTMLElement>('[data-loading]')
        if (el) el.textContent = 'avatar failed to load'
      }
    })()

    return () => {
      // Order matters:
      //   1. Stop scheduling new frames so dispose() races don't fight RAF.
      //   2. Tell the talkinghead lib to tear down its own loop (if exposed).
      //   3. Detach DOM listeners so dangling closures don't keep the
      //      component alive in memory after unmount.
      //   4. Dispose Three.js GPU resources (clones first, then shared mats,
      //      then particle geo/mat).
      //   5. Close AudioContext (async, fire-and-forget — Chrome caps ~6).
      //   6. Null all refs so a re-mount starts from a clean slate.
      cancelled = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null

      // Library teardown — optional chaining since not all versions expose stop().
      try {
        headRef.current?.stop?.()
      } catch (err) {
        console.warn('[TalkingHead] head.stop failed:', err)
      }

      // DOM listeners — explicit removal in case resumeAudio never fired.
      document.removeEventListener('click', resumeAudio)
      document.removeEventListener('touchstart', resumeAudio)
      document.removeEventListener('keydown', resumeAudio)
      motionMQ?.removeEventListener?.('change', onMotionChange)

      // Three.js GPU dispose. Clones first — remove from parent then dispose
      // their geometry. Their material is the shared wireMat, disposed below.
      for (const clone of wireClonesRef.current) {
        try {
          clone.parent?.remove?.(clone.mesh)
          clone.geometry?.dispose?.()
        } catch (err) {
          console.warn('[TalkingHead] wire clone dispose failed:', err)
        }
      }
      wireClonesRef.current = []

      // Particles: remove from scene then dispose its geo + mat.
      try {
        if (particlesRef.current && headRef.current?.scene?.remove) {
          headRef.current.scene.remove(particlesRef.current)
        }
      } catch (err) {
        console.warn('[TalkingHead] particles remove failed:', err)
      }
      particlesRef.current = null

      try { skinMatRef.current?.dispose?.() } catch { /* ignore */ }
      try { wireMatRef.current?.dispose?.() } catch { /* ignore */ }
      try { partGeoRef.current?.dispose?.() } catch { /* ignore */ }
      try { partMatRef.current?.dispose?.() } catch { /* ignore */ }
      skinMatRef.current = null
      wireMatRef.current = null
      partGeoRef.current = null
      partMatRef.current = null

      // AudioContext.close() returns a Promise; React cleanup must be sync,
      // so we fire-and-forget but log rejections. Chrome caps ~6 contexts
      // per origin — leaking one per remount kills audio after a few nav cycles.
      const ctx = audioCtxRef.current
      if (ctx && ctx.state !== 'closed') {
        void ctx.close().catch((err) => {
          console.warn('[TalkingHead] audioCtx.close failed:', err)
        })
      }
      audioCtxRef.current = null

      // Drop cached audio bytes so we don't pin Megabytes of decoded TTS
      // across navigation events.
      audioCacheRef.current.clear()

      // Final ref nulls — must come AFTER dispose calls above used them.
      headRef.current = null
      analyserRef.current = null
      uniformsRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-black"
      aria-label="Firefly — animated avatar narrating your answer"
    >
      <div
        data-loading
        className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11px] tracking-[0.32em] uppercase text-crimson loading-breathe"
      >
        igniting · 0%
      </div>
      {/* Edge-only vignette — pulls the frame in. No center glow, no color bleed. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.8) 100%)',
        }}
      />
    </div>
  )
})

TalkingHeadComponent.displayName = 'TalkingHead'

export default TalkingHeadComponent
