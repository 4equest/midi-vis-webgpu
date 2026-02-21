import { describe, expect, it, vi } from 'vitest'

vi.mock('tone', () => {
  const transport = {
    state: 'stopped',
    seconds: 0,
    stop: vi.fn(() => {
      transport.state = 'stopped'
    }),
    pause: vi.fn(() => {
      transport.state = 'paused'
    }),
    cancel: vi.fn(),
    start: vi.fn(() => {
      transport.state = 'started'
    }),
    scheduleOnce: vi.fn(),
  }

  class DummyAnalyser {
    constructor() {}
    connect() {}
    getValue() {
      return new Float32Array(0)
    }
    dispose() {}
  }

  class DummyGain {
    gain = {
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
    }
    constructor() {}
    connect() {}
    dispose() {}
  }

  const makeParam = (initial = 0) => {
    const p: { value: number; setValueAtTime: ReturnType<typeof vi.fn> } = {
      value: initial,
      setValueAtTime: vi.fn((v: number) => {
        p.value = v
      }),
    }
    return p
  }

  const polySynths: any[] = []
  const vibratos: any[] = []
  const tremolos: any[] = []
  const panVols: any[] = []

  class DummyPolySynth {
    set = vi.fn()
    constructor() {
      polySynths.push(this)
    }
    connect() {}
    triggerAttack = vi.fn()
    triggerRelease = vi.fn()
    triggerAttackRelease() {}
    dispose() {}
  }

  class DummySynth {
    constructor() {}
  }

  class DummyMembraneSynth {
    constructor() {}
    connect() {}
    triggerAttackRelease() {}
    dispose() {}
  }

  class DummyNoiseSynth {
    constructor() {}
    connect() {}
    triggerAttackRelease() {}
    dispose() {}
  }

  class DummyMetalSynth {
    frequency = { value: 0 }
    constructor() {}
    connect() {}
    triggerAttackRelease() {}
    dispose() {}
  }

  class DummyPlayer {
    constructor() {}
    connect() {}
    disconnect() {}
    async load() {}
    start() {}
    stop() {}
    dispose() {}
  }

  class DummyVibrato {
    depth = makeParam(0)
    constructor() {
      vibratos.push(this)
    }
    connect() {}
    dispose() {}
  }

  class DummyTremolo {
    depth = makeParam(0)
    constructor() {
      tremolos.push(this)
    }
    connect() {}
    start() {
      return this
    }
    dispose() {}
  }

  class DummyPanVol {
    pan = makeParam(0)
    volume = makeParam(0)
    constructor() {
      panVols.push(this)
    }
    connect() {}
    dispose() {}
  }

  return {
    getTransport: () => transport,
    getDestination: () => ({}),
    start: vi.fn(async () => {}),
    now: () => 0,
    Analyser: DummyAnalyser,
    Gain: DummyGain,
    PolySynth: DummyPolySynth,
    Synth: DummySynth,
    Vibrato: DummyVibrato,
    Tremolo: DummyTremolo,
    PanVol: DummyPanVol,
    MembraneSynth: DummyMembraneSynth,
    NoiseSynth: DummyNoiseSynth,
    MetalSynth: DummyMetalSynth,
    Player: DummyPlayer,
    __transport: transport,
    __polySynths: polySynths,
    __vibratos: vibratos,
    __tremolos: tremolos,
    __panVols: panVols,
  }
})

describe('AudioEngine', () => {
  it('pauses transport when switching audio modes during playback', async () => {
    const Tone = await import('tone')
    const { AudioEngine } = await import('../src/lib/audio/audioEngine')

    const transport = (Tone as any).__transport as {
      state: string
      pause: ReturnType<typeof vi.fn>
      cancel: ReturnType<typeof vi.fn>
    }

    const engine = new AudioEngine({
      midi: { tracks: [] } as any,
      audioMode: 'external',
      externalAudio: {
        file: { name: 'a.wav', size: 1, lastModified: 0 } as any,
        offsetMs: 0,
      },
    })

    transport.pause.mockClear()
    transport.cancel.mockClear()
    transport.state = 'started'

    engine.setAudioMode('midi')

    expect(transport.pause).toHaveBeenCalledTimes(1)
    expect(transport.cancel).toHaveBeenCalledWith(0)
    expect(transport.state).toBe('paused')
  })

  it('schedules pitch bend and modulation events', async () => {
    const Tone = await import('tone')
    const { AudioEngine } = await import('../src/lib/audio/audioEngine')

    const transport = (Tone as any).__transport as {
      scheduleOnce: ReturnType<typeof vi.fn>
    }
    transport.scheduleOnce.mockClear()

    const engine = new AudioEngine({
      midi: {
        tracks: [
          {
            index: 0,
            name: '',
            channel: 0,
            isDrum: false,
            notes: [],
            pitchBends: [{ ticks: 0, time: 0.5, value: 0.5 }],
            controlChanges: [{ controller: 1, ticks: 0, time: 0.25, value: 0.75 }],
            channelAftertouch: [],
            noteAftertouch: [],
          },
        ],
      } as any,
      audioMode: 'midi',
    })

    await engine.playFrom(0)

    const times = transport.scheduleOnce.mock.calls.map((c) => c[1])
    expect(times).toContain(0.25)
    expect(times).toContain(0.5)

    const bendCall = transport.scheduleOnce.mock.calls.find((c) => c[1] === 0.5)
    const modCall = transport.scheduleOnce.mock.calls.find((c) => c[1] === 0.25)
    expect(bendCall).toBeTruthy()
    expect(modCall).toBeTruthy()

    const polySynth = (Tone as any).__polySynths[0] as { set: ReturnType<typeof vi.fn> }
    const vibrato = (Tone as any).__vibratos[0] as { depth: { setValueAtTime: ReturnType<typeof vi.fn> } }

    // Invoke scheduled callbacks to verify automation effects apply.
    bendCall![0](100)
    expect(polySynth.set).toHaveBeenCalledWith({ detune: 100 })

    modCall![0](200)
    expect(vibrato.depth.setValueAtTime).toHaveBeenCalledWith(0.75, 200)
  })

  it('compacts dense pitch bend streams before scheduling', async () => {
    const Tone = await import('tone')
    const { AudioEngine } = await import('../src/lib/audio/audioEngine')

    const transport = (Tone as any).__transport as {
      scheduleOnce: ReturnType<typeof vi.fn>
    }
    transport.scheduleOnce.mockClear()

    const pitchBends = Array.from({ length: 100 }, (_, i) => ({
      ticks: i,
      time: i * 0.001,
      value: i / 99,
    }))

    const engine = new AudioEngine({
      midi: {
        tracks: [
          {
            index: 0,
            name: '',
            channel: 0,
            isDrum: false,
            notes: [],
            pitchBends,
            controlChanges: [],
            channelAftertouch: [],
            noteAftertouch: [],
          },
        ],
      } as any,
      audioMode: 'midi',
    })

    await engine.playFrom(0)

    // Without compaction this would schedule 100 events; we cap to a small number.
    expect(transport.scheduleOnce.mock.calls.length).toBeLessThan(20)
  })

  it('applies RPN pitch bend range (RPN 0,0)', async () => {
    const Tone = await import('tone')
    const { AudioEngine } = await import('../src/lib/audio/audioEngine')

    ;(Tone as any).__polySynths.length = 0

    const transport = (Tone as any).__transport as { scheduleOnce: ReturnType<typeof vi.fn> }
    transport.scheduleOnce.mockClear()

    const engine = new AudioEngine({
      midi: {
        tracks: [
          {
            index: 0,
            name: '',
            channel: 0,
            isDrum: false,
            notes: [],
            pitchBends: [{ ticks: 0, time: 0.5, value: 0.5 }],
            // RPN 0,0 + Data Entry MSB=12 (range = +/-12 semitones)
            controlChanges: [
              { controller: 101, ticks: 0, time: 0, value: 0 },
              { controller: 100, ticks: 0, time: 0, value: 0 },
              { controller: 6, ticks: 0, time: 0, value: 12 / 127 },
            ],
            channelAftertouch: [],
            noteAftertouch: [],
          },
        ],
      } as any,
      audioMode: 'midi',
    })

    await engine.playFrom(0)

    const bendCall = transport.scheduleOnce.mock.calls.find((c) => c[1] === 0.5)
    expect(bendCall).toBeTruthy()

    const polySynth = (Tone as any).__polySynths[0] as { set: ReturnType<typeof vi.fn> }
    bendCall![0](100)
    // 0.5 bend * 12 semitones * 100 cents = 600 cents
    expect(polySynth.set).toHaveBeenCalledWith({ detune: 600 })
  })

  it('applies CC7 volume and CC10 pan via PanVol', async () => {
    const Tone = await import('tone')
    const { AudioEngine } = await import('../src/lib/audio/audioEngine')

    ;(Tone as any).__panVols.length = 0
    const transport = (Tone as any).__transport as { scheduleOnce: ReturnType<typeof vi.fn> }
    transport.scheduleOnce.mockClear()

    const engine = new AudioEngine({
      midi: {
        tracks: [
          {
            index: 0,
            name: '',
            channel: 0,
            isDrum: false,
            notes: [],
            pitchBends: [],
            controlChanges: [
              { controller: 7, ticks: 0, time: 0.25, value: 0.5 },
              { controller: 10, ticks: 0, time: 0.5, value: 0 },
            ],
            channelAftertouch: [],
            noteAftertouch: [],
          },
        ],
      } as any,
      audioMode: 'midi',
    })

    await engine.playFrom(0)

    const volCall = transport.scheduleOnce.mock.calls.find((c) => c[1] === 0.25)
    const panCall = transport.scheduleOnce.mock.calls.find((c) => c[1] === 0.5)
    expect(volCall).toBeTruthy()
    expect(panCall).toBeTruthy()

    const panVol = (Tone as any).__panVols[0] as {
      pan: { setValueAtTime: ReturnType<typeof vi.fn> }
      volume: { setValueAtTime: ReturnType<typeof vi.fn> }
    }

    volCall![0](100)
    const lastVol = panVol.volume.setValueAtTime.mock.calls.at(-1)!
    expect(lastVol[0]).toBeCloseTo(20 * Math.log10(0.5), 6)
    expect(lastVol[1]).toBe(100)

    panCall![0](200)
    expect(panVol.pan.setValueAtTime).toHaveBeenCalledWith(-1, 200)
  })

  it('defers note release while CC64 sustain is down', async () => {
    const Tone = await import('tone')
    const { AudioEngine } = await import('../src/lib/audio/audioEngine')

    ;(Tone as any).__polySynths.length = 0
    const transport = (Tone as any).__transport as { scheduleOnce: ReturnType<typeof vi.fn> }
    transport.scheduleOnce.mockClear()

    const engine = new AudioEngine({
      midi: {
        tracks: [
          {
            index: 0,
            name: '',
            channel: 0,
            isDrum: false,
            notes: [
              {
                midi: 60,
                velocity: 1,
                ticks: 0,
                durationTicks: 480,
                endTicks: 480,
                time: 0,
                duration: 1,
                endTime: 1,
              },
            ],
            pitchBends: [],
            controlChanges: [
              { controller: 64, ticks: 0, time: 0.5, value: 1 },
              { controller: 64, ticks: 0, time: 1.5, value: 0 },
            ],
            channelAftertouch: [],
            noteAftertouch: [],
          },
        ],
      } as any,
      audioMode: 'midi',
    })

    await engine.playFrom(0)

    const noteOn = transport.scheduleOnce.mock.calls.find((c) => c[1] === 0)
    const sustainDown = transport.scheduleOnce.mock.calls.find((c) => c[1] === 0.5)
    const noteOff = transport.scheduleOnce.mock.calls.find((c) => c[1] === 1)
    const sustainUp = transport.scheduleOnce.mock.calls.find((c) => c[1] === 1.5)
    expect(noteOn).toBeTruthy()
    expect(sustainDown).toBeTruthy()
    expect(noteOff).toBeTruthy()
    expect(sustainUp).toBeTruthy()

    const polySynth = (Tone as any).__polySynths[0] as {
      triggerAttack: ReturnType<typeof vi.fn>
      triggerRelease: ReturnType<typeof vi.fn>
    }

    noteOn![0](0)
    sustainDown![0](500)
    noteOff![0](1000)
    expect(polySynth.triggerRelease).not.toHaveBeenCalled()

    sustainUp![0](1500)
    expect(polySynth.triggerRelease).toHaveBeenCalled()
  })

  it('maps aftertouch to vibrato depth', async () => {
    const Tone = await import('tone')
    const { AudioEngine } = await import('../src/lib/audio/audioEngine')

    ;(Tone as any).__vibratos.length = 0
    const transport = (Tone as any).__transport as { scheduleOnce: ReturnType<typeof vi.fn> }
    transport.scheduleOnce.mockClear()

    const engine = new AudioEngine({
      midi: {
        tracks: [
          {
            index: 0,
            name: '',
            channel: 0,
            isDrum: false,
            notes: [],
            pitchBends: [],
            controlChanges: [],
            channelAftertouch: [{ channel: 0, ticks: 0, time: 0.25, value: 0.6 }],
            noteAftertouch: [],
          },
        ],
      } as any,
      audioMode: 'midi',
    })

    await engine.playFrom(0)

    const atCall = transport.scheduleOnce.mock.calls.find((c) => c[1] === 0.25)
    expect(atCall).toBeTruthy()

    const vibrato = (Tone as any).__vibratos[0] as { depth: { setValueAtTime: ReturnType<typeof vi.fn> } }
    atCall![0](200)
    expect(vibrato.depth.setValueAtTime).toHaveBeenCalledWith(0.6, 200)
  })
})

