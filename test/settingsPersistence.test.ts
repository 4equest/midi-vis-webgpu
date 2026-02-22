import { describe, expect, it } from 'vitest'

import { BUILTIN_WGSL_SHADERS } from '../src/lib/wgsl/builtinShaders'
import { applySettings, serializeSettings } from '../src/lib/state/settingsPersistence'

describe('settingsPersistence', () => {
  it('roundtrips core settings (non-MIDI) including user WGSL shaders', () => {
    const userShader = {
      id: 'user-1',
      name: 'User Shader',
      code: '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }',
      builtin: false,
      defaultParams: { foo: 1 },
    }

    const state: any = {
      title: 'TITLE',
      measuresToDisplay: 4,
      theme: { bgMain: '#000000', bgPanel: '#111111', ink: '#222222', panelInk: '#333333' },
      audioMode: 'external',
      externalAudio: { file: null, offsetMs: 123 },
      wgsl: {
        shaders: [...BUILTIN_WGSL_SHADERS, userShader],
        layers: [{ id: 'layer-x', enabled: false, shaderId: 'user-1', params: { a: 1 } }],
      },
    }

    const saved = serializeSettings(state)

    const target: any = {
      title: 'DEFAULT',
      measuresToDisplay: 2,
      theme: { bgMain: '#FDFEDC', bgPanel: '#EBEBBB', ink: '#FEFDDD', panelInk: '#1C1A0E' },
      audioMode: 'midi',
      externalAudio: { file: null, offsetMs: 0 },
      wgsl: {
        shaders: [...BUILTIN_WGSL_SHADERS],
        layers: [{ id: 'layer-default', enabled: true, shaderId: 'mirage-crayon', params: {} }],
      },
    }

    applySettings(target, saved)

    expect(target.title).toBe('TITLE')
    expect(target.measuresToDisplay).toBe(4)
    expect(target.theme.bgMain).toBe('#000000')
    expect(target.audioMode).toBe('external')
    expect(target.externalAudio.offsetMs).toBe(123)
    expect(target.wgsl.shaders.some((s: any) => s.id === 'user-1')).toBe(true)
    expect(target.wgsl.layers[0]?.shaderId).toBe('user-1')
  })
})

