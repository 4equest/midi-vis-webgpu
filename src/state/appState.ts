import { markRaw, reactive } from 'vue'

import { parseMidiArrayBuffer } from '../lib/midi/parseMidi'
import { pickDefaultDisplayTrackIndices } from '../lib/midi/trackSelect'
import type { MidiParsed } from '../lib/midi/types'
import { BUILTIN_WGSL_SHADERS } from '../lib/wgsl/builtinShaders'
import type { WgslStackState } from '../lib/wgsl/types'

export type AudioMode = 'midi' | 'external'

export interface TrackSetting {
  trackIndex: number
  enabled: boolean
  chordEnabled: boolean
  color: string
}

export interface ExternalAudioSetting {
  file: File | null
  offsetMs: number
}

export interface ThemeSetting {
  /** Main background (e.g. player piano-roll area) */
  bgMain: string
  /** Header/footer panel background */
  bgPanel: string
  /** Player/UI ink (text + graph color base) */
  ink: string
  /** Settings panel ink (higher-contrast) */
  panelInk: string
}

export interface AppState {
  midi: MidiParsed | null
  midiFileName: string | null
  title: string
  measuresToDisplay: number
  trackSettings: TrackSetting[]
  audioMode: AudioMode
  externalAudio: ExternalAudioSetting
  autoplay: boolean
  theme: ThemeSetting
  wgsl: WgslStackState
}

const NOTE_COLORS = ['#F38B0D', '#1CD04B'] as const

export const appState = reactive<AppState>({
  midi: null,
  midiFileName: null,
  title: 'MIDI VISUALIZER',
  measuresToDisplay: 2,
  trackSettings: [],
  audioMode: 'midi',
  externalAudio: { file: null, offsetMs: 0 },
  autoplay: false,
  theme: {
    bgMain: '#FDFEDC',
    bgPanel: '#EBEBBB',
    ink: '#FEFDDD',
    panelInk: '#1C1A0E',
  },
  wgsl: {
    shaders: [...BUILTIN_WGSL_SHADERS],
    layers: [
      {
        id: 'layer-1',
        enabled: true,
        shaderId: 'mirage-crayon',
        params: { ...(BUILTIN_WGSL_SHADERS.find((s) => s.id === 'mirage-crayon')?.defaultParams ?? {}) },
      },
    ],
  },
})

export const appActions = {
  async loadMidiFile(file: File): Promise<void> {
    const arrayBuffer = await file.arrayBuffer()
    const parsed = parseMidiArrayBuffer(arrayBuffer)
    appState.midi = markRaw(parsed)
    appState.midiFileName = file.name
    appState.autoplay = false

    const defaultIndices = new Set(pickDefaultDisplayTrackIndices(parsed.tracks, 2))

    appState.trackSettings = parsed.tracks.map((t) => ({
      trackIndex: t.index,
      enabled: defaultIndices.has(t.index),
      chordEnabled: defaultIndices.has(t.index),
      color: NOTE_COLORS[t.index % NOTE_COLORS.length] ?? NOTE_COLORS[0],
    }))
  },

  reset(): void {
    appState.midi = null
    appState.midiFileName = null
    appState.title = 'MIDI VISUALIZER'
    appState.measuresToDisplay = 2
    appState.trackSettings = []
    appState.audioMode = 'midi'
    appState.externalAudio = { file: null, offsetMs: 0 }
    appState.autoplay = false
    appState.theme = {
      bgMain: '#FDFEDC',
      bgPanel: '#EBEBBB',
      ink: '#FEFDDD',
      panelInk: '#1C1A0E',
    }
    appState.wgsl = {
      shaders: [...BUILTIN_WGSL_SHADERS],
      layers: [
        {
          id: 'layer-1',
          enabled: true,
          shaderId: 'mirage-crayon',
          params: { ...(BUILTIN_WGSL_SHADERS.find((s) => s.id === 'mirage-crayon')?.defaultParams ?? {}) },
        },
      ],
    }
  },
}

