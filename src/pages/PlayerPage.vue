<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { appState } from '../state/appState'
import { AudioEngine } from '../lib/audio/audioEngine'
import { detectChordNameFromMidiNotes } from '../lib/chords/detectChord'
import { ActiveNoteTracker } from '../lib/midi/activeNoteTracker'
import { lowerBoundByStartTick } from '../lib/midi/noteSearch'
import { MidiTiming } from '../lib/midi/timing'
import { rgbaCssFromHex, rgb01FromHex } from '../lib/visual/color'
import { easeOutExpo } from '../lib/visual/easing'
import { getGpuDevice, onGpuDeviceLost, onGpuUncapturedError } from '../lib/webgpu/gpuDevice'
import { PostProcessChain } from '../lib/webgpu/postProcessChain'
import { RectRenderer } from '../lib/webgpu/rectRenderer'

const router = useRouter()

const pianoCanvasEl = ref<HTMLCanvasElement | null>(null)
const spectrumCanvasEl = ref<HTMLCanvasElement | null>(null)
const waveformCanvasEl = ref<HTMLCanvasElement | null>(null)

const webGpuError = ref<string | null>(null)
let rafId = 0
let unmounted = false

onMounted(() => {
  if (!appState.midi) router.replace({ name: 'upload' })
})

const selectedTrackIndices = ref<number[]>([])

const isPlaying = ref(false)
const playPending = ref(false)
const currentSeconds = ref(0)

const timing = computed(() => {
  const midi = appState.midi
  if (!midi) return null
  return new MidiTiming({
    ppq: midi.ppq,
    durationTicks: midi.durationTicks,
    tempos: midi.tempos,
    timeSignatures: midi.timeSignatures,
  })
})

const durationSeconds = computed(() => appState.midi?.durationSeconds ?? 0)
const progress01 = computed(() =>
  durationSeconds.value > 0 ? Math.max(0, Math.min(1, currentSeconds.value / durationSeconds.value)) : 0,
)

const bar = ref(1)
const beat = ref(1)
const subBeat1000 = ref(0)
const beatsPerBar = ref(4)

const barText = computed(() => String(bar.value).padStart(3, '0'))
const beatText = computed(() => String(beat.value).padStart(2, '0'))
const subBeatText = computed(() => String(subBeat1000.value).padStart(3, '0'))
const beatsPerBarClamped = computed(() => {
  const raw = Number(beatsPerBar.value)
  const n = Number.isFinite(raw) ? Math.floor(raw) : 4
  return Math.max(1, Math.min(16, n))
})
const beatInBarClamped = computed(() => Math.max(1, Math.min(beatsPerBarClamped.value, beat.value)))
const subBeatProgress01 = computed(() => Math.max(0, Math.min(1, subBeat1000.value / 1000)))

    const chordText = ref('N.C.')

let audio: AudioEngine | null = null
let noteTracker: ActiveNoteTracker | null = null
let lastChordUpdateMs = 0
let isSeeking = false
let seekMoveListener: ((e: PointerEvent) => void) | null = null
let seekEndListener: ((e: PointerEvent) => void) | null = null
let pianoRenderer: RectRenderer | null = null
let spectrumRenderer: RectRenderer | null = null
let pianoPost: PostProcessChain | null = null
let unsubscribeGpuLost: (() => void) | null = null
let unsubscribeGpuError: (() => void) | null = null
let playRequestId = 0

function beginPlayRequest(): number {
  playRequestId++
  playPending.value = true
  return playRequestId
}

function endPlayRequest(reqId: number): void {
  if (reqId === playRequestId) playPending.value = false
}

const pitchFill = ref<number[]>(Array.from({ length: 12 }, () => 0))
let lastPitchUpdateSeconds = 0

onMounted(async () => {
  const piano = pianoCanvasEl.value
  const spectrum = spectrumCanvasEl.value
  const waveform = waveformCanvasEl.value
  if (!piano || !spectrum || !waveform) return
  const waveCtx = waveform.getContext('2d')
  if (!waveCtx) throw new Error('Waveform canvas 2D context unavailable.')
  waveCtx.lineJoin = 'round'
  waveCtx.lineCap = 'round'

  const shouldAutoplay = appState.autoplay
  appState.autoplay = false

  try {
    const midi = appState.midi
    const t = timing.value
    if (!midi || !t) throw new Error('MIDI not loaded.')

    // Snapshot display tracks for this session (the Player page does not support live track toggling).
    selectedTrackIndices.value = appState.trackSettings.filter((tr) => tr.enabled).map((tr) => tr.trackIndex)

    audio = new AudioEngine({
      midi,
      audioMode: appState.audioMode,
      externalAudio:
        appState.audioMode === 'external' && appState.externalAudio.file
          ? { file: appState.externalAudio.file, offsetMs: appState.externalAudio.offsetMs }
          : undefined,
    })

    // Initialize at time=0.
    audio.setPositionSeconds(0)

    noteTracker = new ActiveNoteTracker({
      midi,
      trackIndices: selectedTrackIndices.value,
      includeDrums: false,
    })
    noteTracker.seek(0)

    const fatalGpuError = (message: string) => {
      if (unmounted || webGpuError.value) return
      webGpuError.value = message
      playRequestId++
      cancelAnimationFrame(rafId)
      rafId = 0
      window.removeEventListener('keydown', onKeyDown)
      cleanupSeekListeners()
      isSeeking = false
      isPlaying.value = false
      playPending.value = false
      audio?.dispose()
      audio = null
      noteTracker = null
      pianoRenderer?.dispose()
      spectrumRenderer?.dispose()
      pianoPost?.dispose()
      pianoRenderer = null
      spectrumRenderer = null
      pianoPost = null
      unsubscribeGpuLost?.()
      unsubscribeGpuLost = null
      unsubscribeGpuError?.()
      unsubscribeGpuError = null
    }

    unsubscribeGpuLost = onGpuDeviceLost((info) => {
      fatalGpuError(`GPU device lost: ${info.message || info.reason}`)
    })

    unsubscribeGpuError = onGpuUncapturedError((err) => {
      fatalGpuError(`GPU error: ${err?.message ?? String(err)}`)
    })

    const gpu = await getGpuDevice()
    if (unmounted) return
    pianoRenderer = new RectRenderer({ ...gpu, canvas: piano })
    spectrumRenderer = new RectRenderer({ ...gpu, canvas: spectrum })
    pianoPost = new PostProcessChain({ device: gpu.device, format: gpu.format })
    pianoPost.setStack({ shaders: appState.wgsl.shaders, layers: appState.wgsl.layers })
    if (unmounted) {
      pianoRenderer?.dispose()
      spectrumRenderer?.dispose()
      pianoPost?.dispose()
      pianoRenderer = null
      spectrumRenderer = null
      pianoPost = null
      return
    }

    const pianoR = pianoRenderer
    const specR = spectrumRenderer

    let pianoInstances = new Float32Array(8 * 2048)
    const spectrumInstances = new Float32Array(8 * 128)

    const bgMain01 = rgb01FromHex(appState.theme.bgMain, [253 / 255, 254 / 255, 220 / 255])
    const bgPanel01 = rgb01FromHex(appState.theme.bgPanel, [235 / 255, 235 / 255, 187 / 255])
    const ink01 = rgb01FromHex(appState.theme.ink, [0.98, 0.99, 0.86])
    const bgMain = { r: bgMain01[0], g: bgMain01[1], b: bgMain01[2], a: 1 }
    const bgPanel = { r: bgPanel01[0], g: bgPanel01[1], b: bgPanel01[2], a: 1 }
    const [inkR, inkG, inkB] = ink01
    const waveStrokeCss = rgbaCssFromHex(appState.theme.ink, 1, 'rgba(254, 253, 221, 1)')
    const waveStrokeDimCss = rgbaCssFromHex(appState.theme.ink, 0.25, 'rgba(254, 253, 221, 0.25)')

    const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

    const displayTracks = selectedTrackIndices.value
      .map((trackIndex) => {
        const tr = midi.tracks[trackIndex]
        if (!tr) return null
        const colorHex = appState.trackSettings.find((s) => s.trackIndex === trackIndex)?.color ?? '#1CD04B'
        return {
          trackIndex,
          notes: tr.notes,
          color: rgb01FromHex(colorHex, [0.11, 0.82, 0.29]),
          startIdx: 0,
          sustains: [] as typeof tr.notes,
          maxEndPrefix: [] as number[],
        }
      })
      .filter((t): t is NonNullable<typeof t> => Boolean(t))

    let minMidi = 127
    let maxMidi = 0
    for (const tr of displayTracks) {
      for (const n of tr.notes) {
        if (n.midi < minMidi) minMidi = n.midi
        if (n.midi > maxMidi) maxMidi = n.midi
      }
    }
    if (minMidi > maxMidi) {
      minMidi = 0
      maxMidi = 127
    }

    // Precompute per-track prefix max end tick for faster sustain-window queries.
    for (const tr of displayTracks) {
      tr.maxEndPrefix = new Array(tr.notes.length)
      let maxEnd = 0
      for (let i = 0; i < tr.notes.length; i++) {
        const end = tr.notes[i]?.endTicks ?? 0
        if (end > maxEnd) maxEnd = end
        tr.maxEndPrefix[i] = maxEnd
      }
    }

    const pitchRange = Math.max(1, maxMidi - minMidi)
    const noteH = 4
    const wipeDurationSeconds = 0.35

    let displayPageIndex = 0
    let wipe: { from: number; to: number; startSeconds: number } | null = null
    let cachedPageStartTick = -1
    let cachedPageEndTick = -1
    let waveGain = 1
    let lastEngineSetSeconds = Number.NaN
    const fpsCapLayer = appState.wgsl.layers.find((l) => l.enabled && l.shaderId === 'fps-cap')
    const fpsCap = typeof fpsCapLayer?.params?.fps === 'number' && Number.isFinite(fpsCapLayer.params.fps) ? fpsCapLayer.params.fps : 0
    const fpsCapIntervalMs = fpsCap > 0 ? 1000 / Math.max(1, fpsCap) : 0
    let lastPianoRenderMs = -Infinity

    const loop = () => {
      if (unmounted || webGpuError.value) return
      const engine = audio
      const timingInst = timing.value
      if (!engine || !timingInst || !pianoR || !specR) {
        rafId = requestAnimationFrame(loop)
        return
      }

      rafId = requestAnimationFrame(loop)

      if (engine.isPlaying() && !isSeeking) {
        currentSeconds.value = engine.getPositionSeconds()
        if (durationSeconds.value > 0 && currentSeconds.value >= durationSeconds.value) {
          currentSeconds.value = durationSeconds.value
          engine.pause()
          isPlaying.value = false
        }
      } else {
        const next = currentSeconds.value
        if (
          isSeeking ||
          !Number.isFinite(lastEngineSetSeconds) ||
          Math.abs(next - lastEngineSetSeconds) > 1e-4
        ) {
          engine.setPositionSeconds(next)
          lastEngineSetSeconds = next
        }
      }

      const curTicks = timingInst.secondsToTicks(currentSeconds.value)
      const pos = timingInst.getBarBeatAtTicks(curTicks)
      bar.value = pos.bar
      beat.value = pos.beat
      subBeat1000.value = pos.subBeat1000
      beatsPerBar.value = pos.timeSignature[0]

      const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1))

      // Chord detection + pitch UI (throttled). Skip while scrubbing to avoid O(N) seeks per frame.
      if (noteTracker && !isSeeking) {
        noteTracker.update(currentSeconds.value)
        const nowMs = performance.now()
        if (nowMs - lastChordUpdateMs >= 80) {
          chordText.value = detectChordNameFromMidiNotes(noteTracker.getActiveMidiNotes())
          lastChordUpdateMs = nowMs
        }

        // Pitch-class squares (decay on note-off, instant on).
        const active = noteTracker.getActiveMidiNotes()
        const activePc = new Set(active.map((n) => ((n % 12) + 12) % 12))
        let dt = currentSeconds.value - lastPitchUpdateSeconds
        if (dt < 0) {
          // Jumped backwards (seek). Reset decay clock + clear stale fills.
          for (let pc = 0; pc < 12; pc++) pitchFill.value[pc] = 0
          lastPitchUpdateSeconds = currentSeconds.value
          dt = 0
        }
        dt = Math.max(0, Math.min(0.1, dt))
        const decayPerSecond = 1 / 1.2 // ~1.2s to fade out
        for (let pc = 0; pc < 12; pc++) {
          if (activePc.has(pc)) pitchFill.value[pc] = 1
          else pitchFill.value[pc] = Math.max(0, pitchFill.value[pc]! - dt * decayPerSecond)
        }
        lastPitchUpdateSeconds = currentSeconds.value
      }

      // Piano roll (rect instances).
      const pianoSize = pianoR.getSize(dpr)
      const pw = pianoSize.width
      const ph = pianoSize.height
      const pageBars = Math.max(1, Math.floor(appState.measuresToDisplay))
      const naturalPageIndex = timingInst.getPageIndexForBar(pos.bar, pageBars)

      if (!engine.isPlaying()) {
        // When paused/seeking, snap pages immediately (avoid wipe animation freezing at p=0).
        displayPageIndex = naturalPageIndex
        wipe = null
      } else {
        if (!wipe && naturalPageIndex !== displayPageIndex) {
          wipe = { from: displayPageIndex, to: naturalPageIndex, startSeconds: currentSeconds.value }
        }
        if (wipe) {
          const p = (currentSeconds.value - wipe.startSeconds) / wipeDurationSeconds
          if (p >= 1) {
            displayPageIndex = wipe.to
            wipe = null
          }
        }
      }

      const tickRange = timingInst.getPageTickRange(displayPageIndex, pageBars)
      const pageStartTick = tickRange.startTick
      const pageEndTick = tickRange.endTick
      const pageLenTicks = Math.max(1, pageEndTick - pageStartTick)

      if (pageStartTick !== cachedPageStartTick || pageEndTick !== cachedPageEndTick) {
        const prevPageEndTick = cachedPageEndTick
        for (const tr of displayTracks) {
          const idx = lowerBoundByStartTick(tr.notes, pageStartTick)

          // Common case (playback): advance by one page. Update sustains incrementally to avoid O(N) scans.
          if (prevPageEndTick === pageStartTick && tr.startIdx <= idx) {
            tr.sustains = tr.sustains.filter((n) => (n.endTicks ?? 0) > pageStartTick)
            for (let i = tr.startIdx; i < idx; i++) {
              const n = tr.notes[i]!
              if ((n.endTicks ?? 0) > pageStartTick) tr.sustains.push(n)
            }
          } else {
            // Fallback: recompute sustains for seek/jump.
            tr.sustains = []
            for (let j = idx - 1; j >= 0; j--) {
              if ((tr.maxEndPrefix[j] ?? 0) <= pageStartTick) break
              const n = tr.notes[j]!
              if ((n.endTicks ?? 0) > pageStartTick) tr.sustains.push(n)
            }
          }

          tr.startIdx = idx
        }
        cachedPageStartTick = pageStartTick
        cachedPageEndTick = pageEndTick
      }

      const wipeProgress = wipe ? clamp01((currentSeconds.value - wipe.startSeconds) / wipeDurationSeconds) : 0
      const wipeEase = wipe ? easeOutExpo(wipeProgress) : 0

      const pushRect = (x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number) => {
        if (rectCount * 8 + 8 > pianoInstances.length) {
          const next = new Float32Array(pianoInstances.length * 2)
          next.set(pianoInstances)
          pianoInstances = next
        }
        const base = rectCount * 8
        pianoInstances[base + 0] = x
        pianoInstances[base + 1] = y
        pianoInstances[base + 2] = w
        pianoInstances[base + 3] = h
        pianoInstances[base + 4] = r
        pianoInstances[base + 5] = g
        pianoInstances[base + 6] = b
        pianoInstances[base + 7] = a
        rectCount++
      }

      let rectCount = 0

      // Playhead in current page.
      const playT = clamp01((curTicks - pageStartTick) / pageLenTicks)
      const playX = Math.min(Math.max(0, pw - 2), Math.floor(playT * pw))
      pushRect(playX, 0, 2, ph, inkR, inkG, inkB, 0.28)

      const padY = 18
      const usableH = Math.max(1, ph - padY * 2)

      for (const tr of displayTracks) {
        const [cr, cg, cb] = tr.color
        for (const n of tr.sustains) {
          const revealT = (curTicks - n.ticks) / Math.max(1, n.durationTicks)
          if (revealT <= 0) continue

          const nx0 = ((n.ticks - pageStartTick) / pageLenTicks) * pw
          const nx1 = ((n.endTicks - pageStartTick) / pageLenTicks) * pw
          const eased = easeOutExpo(clamp01(revealT))
          const visibleEnd = nx0 + (nx1 - nx0) * eased

          let x0 = Math.max(0, nx0)
          let x1 = Math.min(pw, visibleEnd)
          if (wipe) x0 = x0 + (x1 - x0) * wipeEase
          if (x1 <= x0) continue

          const yNorm = (maxMidi - n.midi) / pitchRange
          const y = padY + yNorm * (usableH - noteH)

          const w = x1 - x0
          pushRect(x0, y, w, noteH, cr, cg, cb, 1)
        }
        for (let i = tr.startIdx; i < tr.notes.length; i++) {
          const n = tr.notes[i]!
          if (n.ticks >= pageEndTick) break

          const revealT = (curTicks - n.ticks) / Math.max(1, n.durationTicks)
          if (revealT <= 0) continue

          const nx0 = ((n.ticks - pageStartTick) / pageLenTicks) * pw
          const nx1 = ((n.endTicks - pageStartTick) / pageLenTicks) * pw
          const eased = easeOutExpo(clamp01(revealT))
          const visibleEnd = nx0 + (nx1 - nx0) * eased

          let x0 = Math.max(0, nx0)
          let x1 = Math.min(pw, visibleEnd)
          if (wipe) x0 = x0 + (x1 - x0) * wipeEase
          if (x1 <= x0) continue

          const yNorm = (maxMidi - n.midi) / pitchRange
          const y = padY + yNorm * (usableH - noteH)

          const w = x1 - x0
          pushRect(x0, y, w, noteH, cr, cg, cb, 1)
        }
      }

      try {
        const renderNowMs = performance.now()
        const shouldRenderPiano =
          fpsCapIntervalMs <= 0 || isSeeking || renderNowMs - lastPianoRenderMs >= fpsCapIntervalMs

        if (shouldRenderPiano) {
          const post = pianoPost
          const usePost = Boolean(post && appState.wgsl.layers.some((l) => l.enabled && l.shaderId !== 'fps-cap'))
          if (usePost && post) {
            post.resize(pw, ph)
            const baseView = post.getBaseRenderTargetView()
            if (baseView) {
              pianoR.render({ instances: pianoInstances, instanceCount: rectCount, clear: bgMain, targetView: baseView })
              post.render({ destinationView: pianoR.getCurrentTextureView(dpr), timeSeconds: currentSeconds.value })
            } else {
              pianoR.render({ instances: pianoInstances, instanceCount: rectCount, clear: bgMain })
            }
          } else {
            pianoR.render({ instances: pianoInstances, instanceCount: rectCount, clear: bgMain })
          }
          lastPianoRenderMs = renderNowMs
        }

        // Spectrum bars.
        const spec = engine.getSpectrum()
        const sw = spectrum.clientWidth * dpr
        const sh = spectrum.clientHeight * dpr
        const bins = Math.min(15, spec.length)
        const barW = sw / Math.max(1, 2 * bins - 1) // bars and gaps are equal width
        const gap = barW
        const minH = sh * 0.1
        let specCount = 0
        for (let i = 0; i < bins; i++) {
          const idx = Math.floor((i / Math.max(1, bins - 1)) * (spec.length - 1))
          const db = spec[idx] ?? -100
          const v01 = Math.max(0, Math.min(1, (db + 100) / 100))
          const h = minH + v01 * (sh - minH)
          const x = i * (barW + gap)
          const y = sh - h
          const base = specCount * 8
          spectrumInstances[base + 0] = x
          spectrumInstances[base + 1] = y
          spectrumInstances[base + 2] = barW
          spectrumInstances[base + 3] = h
          spectrumInstances[base + 4] = inkR
          spectrumInstances[base + 5] = inkG
          spectrumInstances[base + 6] = inkB
          spectrumInstances[base + 7] = 1
          specCount++
        }
        specR.render({ instances: spectrumInstances, instanceCount: specCount, clear: bgPanel })

        // Waveform: polyline time-domain signal.
        const ww = Math.max(1, Math.floor(waveform.clientWidth * dpr))
        const wh = Math.max(1, Math.floor(waveform.clientHeight * dpr))
        if (waveform.width !== ww || waveform.height !== wh) {
          waveform.width = ww
          waveform.height = wh
        }

        waveCtx.setTransform(1, 0, 0, 1, 0, 0)
        waveCtx.clearRect(0, 0, ww, wh)
        waveCtx.fillStyle = appState.theme.bgPanel
        waveCtx.fillRect(0, 0, ww, wh)

        const midY = wh * 0.5
        const ampScale = Math.max(1, (wh - 1) * 0.5)

        // Baseline.
        waveCtx.strokeStyle = waveStrokeDimCss
        waveCtx.lineWidth = 1
        waveCtx.beginPath()
        waveCtx.moveTo(0, midY)
        waveCtx.lineTo(ww, midY)
        waveCtx.stroke()

        const wave = engine.getWaveform()
        const viewSamples = Math.min(wave.length, 1280)
        if (viewSamples >= 2) {
          let maxAbs = 0
          for (let i = 0; i < viewSamples; i++) {
            const a = Math.abs(wave[i] ?? 0)
            if (a > maxAbs) maxAbs = a
          }
          const desiredGain = maxAbs > 1e-3 ? Math.min(8, 0.9 / maxAbs) : 1
          waveGain = waveGain * 0.85 + desiredGain * 0.15

          waveCtx.strokeStyle = waveStrokeCss
          waveCtx.beginPath()
          const drawPts = Math.max(2, Math.min(512, viewSamples))
          for (let i = 0; i < drawPts; i++) {
            const idx = Math.floor((i / (drawPts - 1)) * (viewSamples - 1))
            const amp = Math.max(-1, Math.min(1, (wave[idx] ?? 0) * waveGain))
            const x = (i / (drawPts - 1)) * ww
            const y = midY - amp * ampScale
            if (i === 0) waveCtx.moveTo(x, y)
            else waveCtx.lineTo(x, y)
          }
          waveCtx.stroke()
        }
      } catch (err) {
        fatalGpuError(err instanceof Error ? err.message : String(err))
      }
    }

    if (shouldAutoplay) {
      // Start immediately when entering from the settings screen (audio already unlocked there).
      void togglePlay()
    }

    rafId = requestAnimationFrame(loop)
  } catch (err) {
    webGpuError.value = err instanceof Error ? err.message : String(err)
    playRequestId++
    cancelAnimationFrame(rafId)
    rafId = 0
    cleanupSeekListeners()
    isSeeking = false
    isPlaying.value = false
    playPending.value = false
    unsubscribeGpuLost?.()
    unsubscribeGpuLost = null
    unsubscribeGpuError?.()
    unsubscribeGpuError = null
    audio?.dispose()
    audio = null
    noteTracker = null
    pianoRenderer?.dispose()
    spectrumRenderer?.dispose()
    pianoPost?.dispose()
    pianoRenderer = null
    spectrumRenderer = null
    pianoPost = null
  }
})

async function togglePlay() {
  const engine = audio
  if (!engine) return

  if (playPending.value) {
    // Cancel any in-flight play request.
    playRequestId++
    currentSeconds.value = engine.getPositionSeconds()
    engine.pause()
    isPlaying.value = false
    playPending.value = false
    return
  }

  if (!engine.isPlaying()) {
    if (durationSeconds.value > 0 && currentSeconds.value >= durationSeconds.value) {
      currentSeconds.value = 0
      engine.setPositionSeconds(0)
    }
    const reqId = beginPlayRequest()
    isPlaying.value = true
    try {
      await engine.playFrom(currentSeconds.value)
      if (reqId !== playRequestId || unmounted || webGpuError.value || audio !== engine) return
      isPlaying.value = engine.isPlaying()
    } catch (err) {
      if (reqId !== playRequestId || unmounted || webGpuError.value || audio !== engine) return
      isPlaying.value = false
      webGpuError.value = err instanceof Error ? err.message : String(err)
    } finally {
      endPlayRequest(reqId)
    }
    return
  }

  playRequestId++
  currentSeconds.value = engine.getPositionSeconds()
  engine.pause()
  isPlaying.value = false
  playPending.value = false
}

async function seekToSeconds(seconds: number) {
  const engine = audio
  const t = timing.value
  if (!engine || !t) return

  const clamped = Math.max(0, Math.min(durationSeconds.value, seconds))
  currentSeconds.value = clamped

  if (engine.isPlaying() || playPending.value) {
    const reqId = beginPlayRequest()
    isPlaying.value = true
    try {
      await engine.playFrom(clamped)
      if (reqId !== playRequestId || unmounted || webGpuError.value || audio !== engine) return
      isPlaying.value = engine.isPlaying()
    } catch (err) {
      if (reqId !== playRequestId || unmounted || webGpuError.value || audio !== engine) return
      isPlaying.value = false
      webGpuError.value = err instanceof Error ? err.message : String(err)
    } finally {
      endPlayRequest(reqId)
    }
  } else {
    engine.setPositionSeconds(clamped)
  }
}

function onSeekPointerDown(e: PointerEvent) {
  const engine = audio
  if (!engine) return

  cleanupSeekListeners()
  isSeeking = false

  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const pointerId = e.pointerId

  let pointerCaptured = false
  try {
    el.setPointerCapture(pointerId)
    pointerCaptured = true
  } catch {
    // ignore (not all elements/browsers allow capture)
  }

  const wasPlaying = engine.isPlaying() || playPending.value
  if (wasPlaying) {
    playRequestId++
    playPending.value = false
    currentSeconds.value = engine.getPositionSeconds()
    engine.pause()
    isPlaying.value = false
  }

  const setPositionOnly = (ev: PointerEvent) => {
    if (rect.width <= 0 || durationSeconds.value <= 0) return
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left))
    const next = (x / rect.width) * durationSeconds.value
    const clamped = Math.max(0, Math.min(durationSeconds.value, next))
    currentSeconds.value = clamped
    engine.setPositionSeconds(clamped)
  }

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    setPositionOnly(ev)
  }
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    if (!isSeeking || seekEndListener !== end) return
    cleanupSeekListeners()
    isSeeking = false

    try {
      if (pointerCaptured) el.releasePointerCapture(pointerId)
    } catch {
      // ignore
    }

    if (wasPlaying) {
      void (async () => {
        const reqId = beginPlayRequest()
        isPlaying.value = true
        try {
          await engine.playFrom(currentSeconds.value)
          if (reqId !== playRequestId || unmounted || webGpuError.value || audio !== engine) return
          isPlaying.value = engine.isPlaying()
        } catch (err) {
          if (reqId !== playRequestId || unmounted || webGpuError.value || audio !== engine) return
          isPlaying.value = false
          webGpuError.value = err instanceof Error ? err.message : String(err)
        } finally {
          endPlayRequest(reqId)
        }
      })()
    }
  }

  isSeeking = true
  seekMoveListener = move
  seekEndListener = end
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  if (pointerCaptured) el.addEventListener('lostpointercapture', end, { once: true })
  setPositionOnly(e)
}

function cleanupSeekListeners() {
  if (seekMoveListener) window.removeEventListener('pointermove', seekMoveListener)
  if (seekEndListener) {
    window.removeEventListener('pointerup', seekEndListener)
    window.removeEventListener('pointercancel', seekEndListener)
  }
  seekMoveListener = null
  seekEndListener = null
}

function onKeyDown(e: KeyboardEvent) {
  if (webGpuError.value || !audio) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return

  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault()
    void togglePlay()
    return
  }

  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  if (e.metaKey) return
 
  const t = timing.value
  if (!t) return

  const curTicks = t.secondsToTicks(currentSeconds.value)
  const step = t.getSeekStepTicksAtTicks(curTicks, appState.measuresToDisplay)
  const delta = e.key === 'ArrowLeft' ? -1 : 1

  const stepTicks = e.ctrlKey ? step.page : e.shiftKey ? step.bar : step.beat
  const nextTicks = Math.max(0, Math.min(t.durationTicks, curTicks + delta * stepTicks))
  const nextSeconds = t.ticksToSeconds(nextTicks)

  e.preventDefault()
  void seekToSeconds(nextSeconds)
}

onBeforeUnmount(() => {
  unmounted = true
  cancelAnimationFrame(rafId)
  window.removeEventListener('keydown', onKeyDown)
  cleanupSeekListeners()
  unsubscribeGpuLost?.()
  unsubscribeGpuLost = null
  unsubscribeGpuError?.()
  unsubscribeGpuError = null
  audio?.dispose()
  audio = null
  pianoRenderer?.dispose()
  spectrumRenderer?.dispose()
  pianoPost?.dispose()
  pianoRenderer = null
  spectrumRenderer = null
  pianoPost = null
})

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div class="player">
    <header class="player-header">
      <div class="player-title">{{ appState.title }}</div>
    </header>

    <main class="player-main">
      <canvas ref="pianoCanvasEl" class="piano-canvas"></canvas>
      <div v-if="webGpuError" class="webgpu-error">{{ webGpuError }}</div>
    </main>

    <footer class="player-footer">
      <div class="footer-left">
        <canvas ref="spectrumCanvasEl" class="footer-canvas"></canvas>
      </div>

      <div class="footer-center">
        <div class="pitch-grid" aria-label="Active pitch classes (C..B)">
          <div v-for="pc in 12" :key="pc" class="pitch-cell">
            <div class="pitch-outline"></div>
            <div class="pitch-fill" :style="{ opacity: pitchFill[pc - 1] }"></div>
          </div>
        </div>
        <div class="footer-chord">{{ chordText }}</div>
        <div class="footer-controls">
          <div class="footer-progress" @pointerdown="onSeekPointerDown">
            <div class="progress-bg"></div>
            <div class="progress-bar" :style="{ width: `${Math.round(progress01 * 100)}%` }"></div>
          </div>
        </div>
      </div>

      <div class="footer-right">
        <div class="muted footer-right-label" style="text-transform: lowercase">beat</div>
        <div class="footer-numbers">
          <span>{{ barText }}</span>
          <span>{{ beatText }}</span>
          <span>{{ subBeatText }}</span>
        </div>

        <div class="footer-right-progress footer-right-beat-progress" aria-label="Beat progress">
          <div
            v-for="i in beatsPerBarClamped"
            :key="i"
            class="beat-step"
            :class="{ filled: i <= beatInBarClamped }"
          ></div>
        </div>

        <div class="footer-right-progress footer-right-subbeat-progress" aria-label="Sub-beat (1/1000) progress">
          <div class="progress-bg"></div>
          <div class="progress-bar" :style="{ width: `${Math.round(subBeatProgress01 * 100)}%` }"></div>
        </div>
      </div>

      <div class="footer-waveform">
        <canvas ref="waveformCanvasEl" class="footer-canvas"></canvas>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.player {
  height: 100%;
  display: grid;
  grid-template-rows: 125fr 491fr 131fr;
}

.player-header,
.player-footer {
  background: var(--bg-panel);
}

.player-header,
.player-main,
.player-footer {
  /* Ensure grid track sizing honors fr rows (avoid min-content forcing footer to collapse). */
  min-height: 0;
  min-width: 0;
}

.player-title {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--ink);
  font-family: 'Times New Roman', Georgia, serif;
  font-size: clamp(28px, 6.5vmin, 48px);
  line-height: 1;
  font-style: italic;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.9;
}

.player-main {
  position: relative;
}

.piano-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.webgpu-error {
  position: absolute;
  inset: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.25);
  color: var(--ink);
}

.player-footer {
  position: relative;
  padding: 0;
  --footer-key-font: clamp(18px, 3.4vmin, 28px);
  --footer-label-font: clamp(14px, 2.4vmin, 18px);
  --footer-bottom-inset: 20%;
  --footer-bar-h: clamp(5px, 1vmin, 6px);
  --footer-wave-h: clamp(10px, 2.2vmin, 18px);
}

.footer-left,
.footer-center,
.footer-right {
  position: absolute;
  top: 10%;
  bottom: 10%;
}

.footer-left {
  left: 10.53%;
  width: 14%;
  top: 19%;
  bottom: 16%;
}

.footer-center {
  left: 41.65%;
  width: 16.7%;
  top: 13%;
  bottom: var(--footer-bottom-inset);
}

.footer-right {
  left: 69.39%;
  width: 19.94%;
  top: 4%;
  bottom: 2%;
}

.footer-waveform {
  position: absolute;
  left: 69.39%;
  width: 19.94%;
  height: var(--footer-wave-h);
  /* Align waveform TOP with the seek bar TOP (same y), while giving the waveform more height. */
  bottom: calc(var(--footer-bottom-inset) + var(--footer-bar-h) - var(--footer-wave-h));
  pointer-events: none;
}

.footer-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.footer-center {
  display: grid;
  grid-template-rows: auto 1fr auto;
  align-items: center;
  justify-items: center;
  gap: clamp(4px, 0.9vmin, 6px);
}

.pitch-grid {
  display: grid;
  grid-auto-flow: column;
  --pitch-size: clamp(10px, 1.74vmin, 13px);
  --pitch-gap: clamp(4px, 0.8vmin, 6px);
  grid-auto-columns: var(--pitch-size);
  gap: var(--pitch-gap);
  height: var(--pitch-size);
  align-items: center;
  align-self: start;
}

.pitch-cell {
  position: relative;
  width: var(--pitch-size);
  height: var(--pitch-size);
}

.pitch-outline {
  display: none;
}

.pitch-fill {
  position: absolute;
  inset: 0;
  background: var(--ink);
  border-radius: 0;
  transition: opacity 40ms linear;
}

.footer-chord {
  font-size: var(--footer-key-font);
  font-family: 'Times New Roman', Georgia, serif;
  font-style: italic;
  letter-spacing: 0.06em;
  opacity: 0.9;
}

.footer-progress {
  position: relative;
  width: 100%;
  height: var(--footer-bar-h);
  cursor: pointer;
  border-radius: 3px;
}

.progress-bg {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.25);
  border-radius: 3px;
}

.progress-bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ink);
  border-radius: 3px;
}

.footer-right {
  display: grid;
  gap: 1px;
  align-content: start;
  font-size: var(--footer-label-font);
  line-height: 1;
}

.footer-right-label,
.footer-numbers,
.footer-right-progress {
  justify-self: end;
}

.footer-right-beat-progress {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 2px;
  padding: 1px;
}

.beat-step {
  height: 100%;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.25);
}

.beat-step.filled {
  background: var(--ink);
}

.footer-numbers {
  display: flex;
  gap: clamp(8px, 1.8vmin, 14px);
  font-size: var(--footer-key-font);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
  line-height: 1;
}

.footer-right-progress {
  position: relative;
  width: 65%;
  height: var(--footer-bar-h);
  border-radius: 3px;
}

.footer-controls {
  width: 100%;
  display: grid;
  justify-items: stretch;
  align-self: end;
}

</style>

