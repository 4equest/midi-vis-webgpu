<script setup lang="ts">
import * as Tone from 'tone'

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { appState, type AudioMode } from '../state/appState'
import { navigateToPlayerWithAutoplay } from '../lib/navigation/autoplayToPlayer'
import TrackSettingsForm from '../components/TrackSettingsForm.vue'
import { findStartIndexIncludingSustains } from '../lib/midi/noteSearch'
import { MidiTiming } from '../lib/midi/timing'

const router = useRouter()

const errorMessage = ref<string | null>(null)
const previewCanvasEl = ref<HTMLCanvasElement | null>(null)
const noTracksEnabledError = 'Select at least one track to display.'

onMounted(() => {
  if (!appState.midi) router.replace({ name: 'upload' })
})

const previewBars = computed(() => {
  const raw = Number(appState.measuresToDisplay)
  const n = Number.isFinite(raw) ? Math.floor(raw) : 2
  return Math.max(1, Math.min(16, n))
})

const previewTiming = computed(() => {
  const midi = appState.midi
  if (!midi) return null
  return new MidiTiming({
    ppq: midi.ppq,
    durationTicks: midi.durationTicks,
    tempos: midi.tempos,
    timeSignatures: midi.timeSignatures,
  })
})

function setAudioMode(mode: AudioMode) {
  appState.audioMode = mode
  if (mode === 'midi') {
    appState.externalAudio.file = null
  }
}

function onExternalAudioFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  appState.externalAudio.file = input.files?.[0] ?? null
  input.value = ''
}

function drawPreview() {
  const canvas = previewCanvasEl.value
  const midi = appState.midi
  if (!canvas || !midi) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }

  ctx.clearRect(0, 0, w, h)

  const pageBars = previewBars.value
  const timing = previewTiming.value
  if (!timing) return
  const { startTick, endTick } = timing.getPageTickRange(0, pageBars)
  const lenTicks = Math.max(1, endTick - startTick)

  const hexToRgba = (hex: string, alpha: number) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return `rgba(0,0,0,${alpha})`
    const n = Number.parseInt(m[1]!, 16)
    const r = (n >> 16) & 0xff
    const g = (n >> 8) & 0xff
    const b = n & 0xff
    return `rgba(${r},${g},${b},${alpha})`
  }

  const tracks = appState.trackSettings.filter((t) => t.enabled)
  if (tracks.length === 0) return

  // Compute pitch bounds within the window.
  let minMidi = 127
  let maxMidi = 0
  const trackInfos: { notes: typeof midi.tracks[number]['notes']; startIdx: number; color: string }[] = []
  for (const t of tracks) {
    const tr = midi.tracks[t.trackIndex]
    if (!tr) continue
    const notes = tr.notes
    const startIdx = findStartIndexIncludingSustains(notes, startTick)
    trackInfos.push({ notes, startIdx, color: t.color })
    for (let i = startIdx; i < notes.length; i++) {
      const n = notes[i]!
      if (n.ticks >= endTick) break
      if (n.endTicks <= startTick) continue
      if (n.midi < minMidi) minMidi = n.midi
      if (n.midi > maxMidi) maxMidi = n.midi
    }
  }
  if (minMidi > maxMidi) {
    minMidi = 0
    maxMidi = 127
  }

  const pad = Math.floor(6 * dpr)
  const noteH = Math.max(1, Math.floor(2 * dpr))
  const usableH = Math.max(1, h - pad * 2)
  const pitchRange = Math.max(1, maxMidi - minMidi)

  // Background grid line.
  ctx.fillStyle = 'rgba(0,0,0,0.06)'
  ctx.fillRect(0, Math.floor(h * 0.5), w, 1)

  for (const tr of trackInfos) {
    ctx.fillStyle = hexToRgba(tr.color, 0.7)
    for (let i = tr.startIdx; i < tr.notes.length; i++) {
      const n = tr.notes[i]!
      if (n.ticks >= endTick) break
      if (n.endTicks <= startTick) continue

      const x0 = Math.max(0, ((n.ticks - startTick) / lenTicks) * w)
      const x1 = Math.min(w, ((n.endTicks - startTick) / lenTicks) * w)
      if (x1 <= x0) continue

      const yNorm = (maxMidi - n.midi) / pitchRange
      const y = pad + yNorm * (usableH - noteH)
      ctx.fillRect(Math.floor(x0), Math.floor(y), Math.max(1, Math.floor(x1 - x0)), noteH)
    }
  }
}

let drawScheduled = false
function scheduleDrawPreview() {
  if (drawScheduled) return
  drawScheduled = true
  requestAnimationFrame(() => {
    drawScheduled = false
    drawPreview()
  })
}

watch(
  () => [appState.measuresToDisplay, appState.trackSettings.map((t) => [t.enabled, t.color])],
  () => {
    scheduleDrawPreview()
  },
  { deep: true, immediate: true },
)

watch(
  () => appState.trackSettings.map((t) => t.enabled),
  () => {
    if (errorMessage.value === noTracksEnabledError && appState.trackSettings.some((t) => t.enabled)) {
      errorMessage.value = null
    }
  },
  { deep: true },
)

onMounted(() => {
  scheduleDrawPreview()
  window.addEventListener('resize', scheduleDrawPreview)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleDrawPreview)
})

async function startPlayback() {
  errorMessage.value = null

  const anyEnabled = appState.trackSettings.some((t) => t.enabled)
  if (!anyEnabled) {
    errorMessage.value = noTracksEnabledError
    return
  }

  if (appState.audioMode === 'external' && !appState.externalAudio.file) {
    errorMessage.value = 'External audio mode requires selecting an mp3/wav file.'
    return
  }

  try {
    await Tone.start()
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
    return
  }

  try {
    await navigateToPlayerWithAutoplay(router)
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="page">
    <div class="panel">
      <h1 class="panel-title">Select Tracks</h1>

      <div style="display: grid; gap: 6px; margin: 0 0 14px">
        <div class="muted">Preview (first {{ previewBars }} bar(s))</div>
        <canvas
          ref="previewCanvasEl"
          style="width: 100%; height: 110px; border-radius: 10px; background: var(--bg-main)"
        ></canvas>
      </div>

      <div style="display: grid; gap: 12px">
        <TrackSettingsForm />

        <div style="display: grid; gap: 8px">
          <span class="muted">Audio</span>
          <div style="display: grid; gap: 6px">
            <label style="display: flex; gap: 8px; align-items: center">
              <input
                type="radio"
                name="audioMode"
                :checked="appState.audioMode === 'midi'"
                @change="setAudioMode('midi')"
              />
              <span>MIDI (Tone.js instruments + drum kit)</span>
            </label>
            <label style="display: flex; gap: 8px; align-items: center">
              <input
                type="radio"
                name="audioMode"
                :checked="appState.audioMode === 'external'"
                @change="setAudioMode('external')"
              />
              <span>External (mp3/wav) — mute MIDI</span>
            </label>
          </div>

          <div v-if="appState.audioMode === 'external'" style="display: grid; gap: 10px">
            <label style="display: grid; gap: 6px">
              <span class="muted">Audio file (mp3/wav)</span>
              <input type="file" accept="audio/*,.mp3,.wav" @change="onExternalAudioFileChange" />
              <span v-if="appState.externalAudio.file" class="muted">
                Selected: {{ appState.externalAudio.file.name }}
              </span>
            </label>

            <label style="display: grid; gap: 6px">
              <span class="muted">Offset (ms)</span>
              <input v-model.number="appState.externalAudio.offsetMs" type="number" step="1" />
            </label>
          </div>
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px">
        <button class="btn" type="button" @click="router.push({ name: 'shaders' })">Shaders</button>
        <button class="btn" type="button" @click="startPlayback">Start</button>
      </div>

      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </div>
  </div>
</template>

