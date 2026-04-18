/**
 * TalkingHead — BMTH-themed glowing humanoid avatar.
 *
 * Built on @met4citizen/talkinghead (handles GLB load, morph targets, idle
 * motion, head.speakAudio). We then:
 *   1. Swap the default materials for a custom GLSL shader (flesh base +
 *      crimson fresnel rim + audio-reactive emissive).
 *   2. Rig a proper 3-point studio light: crimson key, cool fill, warm back.
 *   3. Add an orbiting particle aura in the same scene graph.
 *   4. Drive voice-reactive uniforms from the decoded audio buffer.
 *   5. Apply a CSS-based bloom/vignette overlay (avoids fighting the
 *      library's render loop with a full EffectComposer).
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export interface AudioTimings {
  words: string[]
  wtimes: number[]
  wdurations: number[]
}

export interface TalkingHeadHandle {
  speak: (text: string) => void
  speakWithAudio: (audioUrl: string, timings: AudioTimings) => void
  stopSpeaking: () => void
  warmUpAudio: () => void
}

const AVATAR_URL = '/avatars/avatarsdk.glb'

// ────────────────────────────────────────────────────────────────
// Custom shader: physically-inspired flesh + crimson fresnel rim
// + audio-reactive emissive. Cheap enough for 60fps on integrated GPU.
// ────────────────────────────────────────────────────────────────
const VERT_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec2 vUv;

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

    vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
    vec4 mvPos    = viewMatrix * worldPos;

    vNormal  = normalize(normalMatrix * objectNormal);
    vViewPos = -mvPos.xyz;
    vUv      = uv;

    gl_Position = projectionMatrix * mvPos;
  }
`

const FRAG_SHADER = /* glsl */ `
  precision highp float;

  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec2 vUv;

  uniform vec3  uBaseColor;
  uniform vec3  uRimColor;
  uniform vec3  uEmissiveColor;
  uniform float uRimPower;
  uniform float uRimStrength;
  uniform float uAudio;       // 0..1 — audio amplitude (voice reactive)
  uniform float uTime;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewPos);

    // Wrapped NdotL-ish term gives a softer, less harsh diffuse falloff
    float wrap = clamp(dot(N, normalize(vec3(0.35, 0.55, 0.8))) * 0.5 + 0.5, 0.0, 1.0);
    vec3  base = uBaseColor * (0.35 + 0.65 * wrap);

    // Fresnel rim — hottest at silhouette. This is the "magical glow".
    float fres = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
    vec3  rim  = uRimColor * fres * uRimStrength;

    // Audio-reactive emissive: speaks louder -> more internal glow.
    // Subtle pulsing during idle via uTime.
    float pulse    = 0.85 + 0.15 * sin(uTime * 0.8);
    vec3  emissive = uEmissiveColor * (0.22 * pulse + 1.4 * uAudio);

    vec3 color = base + rim + emissive;

    // Gentle ACES-ish tone curve to avoid clipping in bright rim regions.
    color = color / (color + vec3(0.55));
    color = pow(color, vec3(1.0 / 2.2));

    gl_FragColor = vec4(color, 1.0);
  }
`

function buildAvatarMaterial(
  THREE: typeof import('three'),
  uniformsOut: { current: Record<string, { value: unknown }> | null },
) {
  const uniforms = {
    uBaseColor:     { value: new THREE.Color('#D6B7A8') }, // warm flesh
    uRimColor:      { value: new THREE.Color('#FF2430') }, // crimson bleed
    uEmissiveColor: { value: new THREE.Color('#FF1220') },
    uRimPower:      { value: 2.4 },
    uRimStrength:   { value: 1.25 },
    uAudio:         { value: 0 },
    uTime:          { value: 0 },
  }
  uniformsOut.current = uniforms

  const mat = new THREE.ShaderMaterial({
    vertexShader:   VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    uniforms,
    transparent:    false,
    side:           THREE.FrontSide,
  })
  // Required for the #include <skinning_pars_vertex> + morph includes to work
  ;(mat as unknown as { skinning: boolean }).skinning = true
  ;(mat as unknown as { morphTargets: boolean }).morphTargets = true
  return mat
}

const TalkingHeadComponent = forwardRef<TalkingHeadHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headRef = useRef<any>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const uniformsRef = useRef<Record<string, { value: unknown }> | null>(null)
  const rafRef = useRef<number | null>(null)

  function getAudioContext(): AudioContext {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext()
    }
    if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume()
    }
    if (headRef.current?.audioCtx?.state === 'suspended') {
      void headRef.current.audioCtx.resume()
    }
    return audioCtxRef.current
  }

  useImperativeHandle(ref, () => ({
    speak(_text: string) {
      // no-op: real speech happens via speakWithAudio once TTS arrives
    },
    warmUpAudio() {
      getAudioContext()
      if (headRef.current?.audioCtx?.state === 'suspended') {
        void headRef.current.audioCtx.resume()
      }
    },
    stopSpeaking() {
      headRef.current?.stopSpeaking()
      headRef.current?.setMood('neutral')
      const u = uniformsRef.current
      if (u) (u.uAudio as { value: number }).value = 0
    },
    async speakWithAudio(audioUrl: string, timings: AudioTimings) {
      if (!headRef.current) return
      try {
        const audioCtx = getAudioContext()
        const response = await fetch(audioUrl)
        const arrayBuffer = await response.arrayBuffer()
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)

        headRef.current.setMood('happy')

        // Tap into the library's audio graph for voice-reactive shader uniforms.
        // The library will play audioBuffer through its own audio source —
        // we attach an AnalyserNode to its destination for amplitude reads.
        if (!analyserRef.current && headRef.current.audioCtx) {
          const analyser = headRef.current.audioCtx.createAnalyser()
          analyser.fftSize = 128
          analyser.smoothingTimeConstant = 0.75
          // Route the library's audioGain (if exposed) through the analyser.
          // Fallback: use the audioCtx destination tap.
          if (headRef.current.audioGain) {
            headRef.current.audioGain.connect(analyser)
          }
          analyserRef.current = analyser
        }

        headRef.current.speakAudio(
          {
            audio: audioBuffer,
            words: timings.words,
            wtimes: timings.wtimes,
            wdurations: timings.wdurations,
            visemes: [],
          },
          {},
          undefined,
        )

        const durationMs = timings.wtimes.at(-1)! + timings.wdurations.at(-1)!
        setTimeout(() => {
          headRef.current?.setMood('neutral')
          const u = uniformsRef.current
          if (u) (u.uAudio as { value: number }).value = 0
        }, durationMs + 500)
      } catch (err) {
        console.error('[TalkingHead] speakWithAudio failed:', err)
      }
    },
  }))

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    let cancelled = false

    ;(async () => {
      try {
        const [{ TalkingHead }, THREE] = await Promise.all([
          import('@met4citizen/talkinghead'),
          import('three'),
        ])
        if (cancelled) return

        const head = new TalkingHead(container, {
          cameraView: 'head',
          cameraRotateEnable: false,
          lipsyncModules: [],
          lipsyncLang: 'en',
          avatarMood: 'neutral',
          avatarIdleEyeContact: 0.7,
          avatarIdleHeadMove: 0.5,
          avatarSpeakingEyeContact: 0.8,
          avatarSpeakingHeadMove: 0.7,
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

        // ── Replace default materials with custom shader ──
        const avatarMat = buildAvatarMaterial(THREE, uniformsRef)
        head.armature.traverse((child: any) => {
          if (!child.isMesh) return
          child.material = avatarMat
          child.castShadow = false
          child.receiveShadow = false
        })

        // ── Cinematic lighting rig ──
        // Kill or dampen any existing lights in the library's scene.
        head.scene.traverse((obj: any) => {
          if (obj.isLight) obj.intensity *= 0.3
        })

        const keyLight  = new THREE.DirectionalLight(0xff2430, 1.8) // crimson
        keyLight.position.set(-1.2, 1.4, 1.6)
        const fillLight = new THREE.DirectionalLight(0x60d0ff, 0.35) // cool fill
        fillLight.position.set(1.4, 0.6, 0.8)
        const backLight = new THREE.DirectionalLight(0xff5a3c, 0.85) // warm back-rim
        backLight.position.set(0.2, 1.2, -2.2)
        const ambient   = new THREE.AmbientLight(0x180808, 0.6)
        head.scene.add(keyLight, fillLight, backLight, ambient)

        // ── Particle aura (orbiting fireflies) ──
        const PARTICLE_COUNT = 900
        const positions = new Float32Array(PARTICLE_COUNT * 3)
        const seeds     = new Float32Array(PARTICLE_COUNT)
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          const theta = Math.random() * Math.PI * 2
          const phi   = Math.acos(2 * Math.random() - 1)
          const r     = 0.55 + Math.random() * 0.6
          positions[i * 3 + 0] = Math.sin(phi) * Math.cos(theta) * r
          positions[i * 3 + 1] = Math.cos(phi) * r + 1.55
          positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r
          seeds[i] = Math.random()
        }
        const partGeo = new THREE.BufferGeometry()
        partGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        partGeo.setAttribute('aSeed',    new THREE.BufferAttribute(seeds, 1))

        const partMat = new THREE.ShaderMaterial({
          uniforms: {
            uTime:  { value: 0 },
            uAudio: uniformsRef.current!.uAudio,
          },
          vertexShader: /* glsl */ `
            attribute float aSeed;
            uniform float uTime;
            uniform float uAudio;
            varying float vAlpha;
            void main() {
              vec3 p = position;
              float t  = uTime * (0.25 + aSeed * 0.6) + aSeed * 6.28;
              p.x += sin(t) * 0.06;
              p.y += cos(t * 1.2) * 0.05;
              p.z += sin(t * 0.8) * 0.06;
              vec4 mv = modelViewMatrix * vec4(p, 1.0);
              gl_Position = projectionMatrix * mv;
              // Size in pixels — smaller points feel premium, not "glitter"
              gl_PointSize = (1.6 + aSeed * 1.6 + uAudio * 2.0)
                * (220.0 / -mv.z);
              vAlpha = 0.35 + 0.55 * sin(t * 2.2 + aSeed * 9.0);
            }
          `,
          fragmentShader: /* glsl */ `
            precision highp float;
            varying float vAlpha;
            void main() {
              vec2 uv = gl_PointCoord - 0.5;
              float d = length(uv);
              if (d > 0.5) discard;
              float a = smoothstep(0.5, 0.0, d) * vAlpha;
              // Warm amber core -> crimson glow
              vec3 col = mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.12, 0.14), d * 2.0);
              gl_FragColor = vec4(col, a);
            }
          `,
          transparent: true,
          depthWrite:  false,
          blending:    THREE.AdditiveBlending,
        })
        const particles = new THREE.Points(partGeo, partMat)
        head.scene.add(particles)

        // ── Voice-reactive + idle uniform updates ──
        const amps = new Uint8Array(64)
        const clock = new THREE.Clock()
        function tick() {
          if (cancelled) return
          const t = clock.getElapsedTime()
          const uniforms = uniformsRef.current
          if (uniforms) {
            ;(uniforms.uTime as { value: number }).value = t
            // Audio-reactive read
            let amp = 0
            const analyser = analyserRef.current
            if (analyser) {
              analyser.getByteFrequencyData(amps)
              let s = 0
              for (let i = 0; i < amps.length; i++) s += amps[i]
              amp = Math.min(1, s / (amps.length * 220))
            }
            // Easing towards target to avoid shader flicker
            const cur = (uniforms.uAudio as { value: number }).value
            ;(uniforms.uAudio as { value: number }).value = cur + (amp - cur) * 0.25
          }
          ;(partMat.uniforms.uTime as { value: number }).value = t

          // Subtle cinematic camera drift via head-position sway
          if (head.camera) {
            head.camera.position.x = Math.sin(t * 0.16) * 0.03
            head.camera.position.y = 1.65 + Math.sin(t * 0.21) * 0.015
          }
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)

        head.renderer.setClearColor(0x0A0808, 1)

        const overlay = container.querySelector<HTMLElement>('[data-loading]')
        if (overlay) overlay.style.display = 'none'

        const resumeAudio = () => {
          if (head.audioCtx?.state === 'suspended') void head.audioCtx.resume()
          document.removeEventListener('click', resumeAudio)
          document.removeEventListener('touchstart', resumeAudio)
          document.removeEventListener('keydown', resumeAudio)
        }
        document.addEventListener('click', resumeAudio)
        document.addEventListener('touchstart', resumeAudio)
        document.addEventListener('keydown', resumeAudio)

        headRef.current = head
      } catch (err) {
        console.error('[TalkingHead] init failed:', err)
        const el = container.querySelector<HTMLElement>('[data-loading]')
        if (el) el.textContent = 'avatar failed to load'
      }
    })()

    return () => {
      cancelled = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      headRef.current = null
      analyserRef.current = null
      uniformsRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      style={{
        background:
          'radial-gradient(ellipse 70% 60% at 50% 55%, rgba(214,0,23,0.14) 0%, rgba(10,8,8,1) 65%)',
      }}
      aria-label="Firefly — animated avatar narrating your answer"
    >
      {/* Loading indicator — BMTH styled */}
      <div
        data-loading
        className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11px] tracking-[0.32em] uppercase text-crimson loading-breathe"
      >
        igniting · 0%
      </div>

      {/* Bloom halo — CSS-based lightweight approximation of scene bloom.
          Bloom'ish glow around the face area, additive blend. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 42%, rgba(255,42,42,0.18) 0%, rgba(255,42,42,0.06) 22%, transparent 44%)',
          mixBlendMode: 'screen',
        }}
      />

      {/* Vignette — tightens the frame, BMTH-style */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%)',
        }}
      />
    </div>
  )
})

TalkingHeadComponent.displayName = 'TalkingHead'

export default TalkingHeadComponent
