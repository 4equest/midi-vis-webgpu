import { watch } from 'vue'

import type { AppState, AudioMode, ThemeSetting } from '../../state/appState'
import { BUILTIN_WGSL_SHADERS } from '../wgsl/builtinShaders'
import type { WgslLayerConfig, WgslShaderDefinition } from '../wgsl/types'

export const SETTINGS_STORAGE_KEY = 'midi-vis:settings:v1'

export type PersistedSettingsV1 = {
  v: 1
  title: string
  measuresToDisplay: number
  theme: ThemeSetting
  audioMode: AudioMode
  externalOffsetMs: number
  wgsl: {
    userShaders: Array<Pick<WgslShaderDefinition, 'id' | 'name' | 'code' | 'builtin' | 'defaultParams'>>
    layers: WgslLayerConfig[]
  }
}

export function serializeSettings(state: Pick<AppState, 'title' | 'measuresToDisplay' | 'theme' | 'audioMode' | 'externalAudio' | 'wgsl'>): PersistedSettingsV1 {
  const userShaders = state.wgsl.shaders
    .filter((s) => !s.builtin)
    .map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      builtin: false,
      defaultParams: s.defaultParams,
    }))

  const layers = state.wgsl.layers.map((l) => ({
    id: l.id,
    enabled: Boolean(l.enabled),
    shaderId: l.shaderId,
    params: { ...l.params },
  }))

  return {
    v: 1,
    title: state.title,
    measuresToDisplay: state.measuresToDisplay,
    theme: { ...state.theme },
    audioMode: state.audioMode,
    externalOffsetMs: state.externalAudio.offsetMs,
    wgsl: { userShaders, layers },
  }
}

export function applySettings(state: Pick<AppState, 'title' | 'measuresToDisplay' | 'theme' | 'audioMode' | 'externalAudio' | 'wgsl'>, persisted: PersistedSettingsV1): void {
  if (!persisted || persisted.v !== 1) return

  if (typeof persisted.title === 'string') state.title = persisted.title

  const m = Number(persisted.measuresToDisplay)
  if (Number.isFinite(m)) state.measuresToDisplay = m

  if (persisted.theme && typeof persisted.theme === 'object') {
    const t = persisted.theme as Partial<Record<keyof ThemeSetting, unknown>>
    state.theme = {
      ...state.theme,
      ...(typeof t.bgMain === 'string' ? { bgMain: t.bgMain } : {}),
      ...(typeof t.bgPanel === 'string' ? { bgPanel: t.bgPanel } : {}),
      ...(typeof t.ink === 'string' ? { ink: t.ink } : {}),
      ...(typeof t.panelInk === 'string' ? { panelInk: t.panelInk } : {}),
    }
  }

  state.audioMode = persisted.audioMode === 'external' ? 'external' : 'midi'
  state.externalAudio.offsetMs = Number.isFinite(persisted.externalOffsetMs) ? persisted.externalOffsetMs : state.externalAudio.offsetMs
  // External file cannot be persisted.
  state.externalAudio.file = null

  const userShaders = Array.isArray(persisted.wgsl?.userShaders)
    ? persisted.wgsl.userShaders
        .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.code === 'string')
        .map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          builtin: false,
          defaultParams: s.defaultParams,
        }))
    : []

  state.wgsl.shaders = [...BUILTIN_WGSL_SHADERS, ...userShaders]
  const shaderIds = new Set(state.wgsl.shaders.map((s) => s.id))

  const layers = Array.isArray(persisted.wgsl?.layers)
    ? persisted.wgsl.layers.filter((l) => l && typeof l.id === 'string' && typeof l.shaderId === 'string')
    : []

  const nextLayers = layers
    .filter((l) => shaderIds.has(l.shaderId))
    .map((l) => ({ id: l.id, enabled: Boolean(l.enabled), shaderId: l.shaderId, params: { ...(l.params ?? {}) } }))

  if (nextLayers.length > 0) state.wgsl.layers = nextLayers
}

export function initSettingsPersistence(state: AppState, opts: { storage?: Storage; debounceMs?: number } = {}): () => void {
  let storage: Storage | undefined = opts.storage
  if (!storage) {
    try {
      storage = (globalThis as any).localStorage as Storage
    } catch {
      storage = undefined
    }
  }
  const debounceMs = Number.isFinite(opts.debounceMs) ? Math.max(0, opts.debounceMs!) : 150

  if (!storage) return () => {}

  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedSettingsV1
      if (parsed && parsed.v === 1) applySettings(state, parsed)
    }
  } catch {
    // ignore (storage disabled / invalid json)
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = watch(
    () => serializeSettings(state),
    (next) => {
      if (timer !== null) globalThis.clearTimeout(timer)
      timer = globalThis.setTimeout(() => {
        timer = null
        try {
          storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next))
        } catch {
          // ignore
        }
      }, debounceMs)
    },
    { deep: true },
  )

  return () => {
    stop()
    if (timer !== null) globalThis.clearTimeout(timer)
  }
}

