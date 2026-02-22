import * as Tone from 'tone'

import type { MidiParsed, MidiTrack } from '../midi/types'

export type AudioMode = 'midi' | 'external'

export interface ExternalAudioConfig {
  file: File
  /** External audio offset relative to MIDI timeline, in milliseconds. Positive = skip forward in the audio. */
  offsetMs: number
}

export interface AudioEngineConfig {
  midi: MidiParsed
  audioMode: AudioMode
  externalAudio?: ExternalAudioConfig
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

const DEFAULT_PITCH_BEND_RANGE_SEMITONES = 2

type ChannelState = {
  pitchBendRangeSemitones: number
  pitchBendValue: number

  modWheel: number
  aftertouch: number
  tremolo: number

  volume: number
  expression: number
  pan: number

  sustainDown: boolean
  sustainedNotes: Set<number>
}

type ChannelFx = {
  readonly synth: Tone.PolySynth
  readonly vibrato: Tone.Vibrato
  readonly tremolo: Tone.Tremolo
  readonly panVol: Tone.PanVol
  readonly state: ChannelState
}

class DrumKit {
  private readonly kick = new Tone.MembraneSynth({
    pitchDecay: 0.03,
    octaves: 10,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0.0, release: 0.05 },
  })
  private readonly snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.12, sustain: 0.0 },
  })
  private readonly hat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.06, release: 0.01 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 2300,
    octaves: 1.5,
  })

  connect(node: Tone.ToneAudioNode): void {
    this.kick.connect(node)
    this.snare.connect(node)
    this.hat.connect(node)
    this.hat.frequency.value = 280
  }

  trigger(midi: number, time: number, velocity: number): void {
    // Basic General MIDI mapping (subset).
    if (midi === 36 || midi === 35) {
      this.kick.triggerAttackRelease('C1', 0.2, time, velocity)
      return
    }
    if (midi === 38 || midi === 40) {
      this.snare.triggerAttackRelease(0.12, time, velocity)
      return
    }
    if (midi === 42 || midi === 44 || midi === 46) {
      this.hat.triggerAttackRelease(0.05, time, velocity)
      return
    }
    // Fallback: short click-like hat.
    this.hat.triggerAttackRelease(0.03, time, Math.max(0.2, velocity))
  }

  dispose(): void {
    this.kick.dispose()
    this.snare.dispose()
    this.hat.dispose()
  }
}

export class AudioEngine {
  private readonly transport = Tone.getTransport()

  private readonly output = new Tone.Gain(1)
  private readonly spectrumAnalyser = new Tone.Analyser('fft', 128)
  private readonly waveformAnalyser = new Tone.Analyser('waveform', 2048)

  private readonly drumKit = new DrumKit()
  private readonly channels = new Map<number, ChannelFx>()

  private midi: MidiParsed
  private audioMode: AudioMode
  private externalAudio: ExternalAudioConfig | null

  private externalPlayer: Tone.Player | null = null
  private externalObjectUrl: string | null = null
  private externalFileKey: string | null = null
  private externalLoadKey: string | null = null
  private externalLoadPromise: Promise<void> | null = null
  private playGeneration = 0
  private disposed = false

  private releaseAllVoices(time: number): void {
    for (const fx of this.channels.values()) {
      fx.state.sustainDown = false
      fx.state.sustainedNotes.clear()
      fx.synth.releaseAll(time)
    }
  }

  constructor(cfg: AudioEngineConfig) {
    this.midi = cfg.midi
    this.audioMode = cfg.audioMode
    this.externalAudio = cfg.externalAudio ?? null

    this.output.connect(Tone.getDestination())
    this.output.connect(this.spectrumAnalyser)
    this.output.connect(this.waveformAnalyser)

    this.drumKit.connect(this.output)

    // Ensure a clean transport state.
    this.transport.stop()
    this.transport.cancel(0)
  }

  async ensureStarted(): Promise<void> {
    await Tone.start()
  }

  setAudioMode(mode: AudioMode, externalAudio?: ExternalAudioConfig): void {
    if (this.disposed) return

    const prevMode = this.audioMode
    const prevExternalFileKey = this.externalAudio
      ? `${this.externalAudio.file.name}:${this.externalAudio.file.size}:${this.externalAudio.file.lastModified}`
      : null
    const prevExternalKey = this.externalAudio
      ? `${this.externalAudio.file.name}:${this.externalAudio.file.size}:${this.externalAudio.file.lastModified}:${this.externalAudio.offsetMs}`
      : null
    const nextExternal = externalAudio ?? null
    const nextExternalFileKey = nextExternal
      ? `${nextExternal.file.name}:${nextExternal.file.size}:${nextExternal.file.lastModified}`
      : null
    const nextExternalKey = nextExternal
      ? `${nextExternal.file.name}:${nextExternal.file.size}:${nextExternal.file.lastModified}:${nextExternal.offsetMs}`
      : null

    this.audioMode = mode
    this.externalAudio = nextExternal

    // Switching modes (or changing the external source while in external mode) is treated as a stop.
    const needsRestart = mode !== prevMode || (mode === 'external' && prevExternalKey !== nextExternalKey)
    if (needsRestart) this.pause()

    // If the external file changed, invalidate any in-flight load and drop the old decoded buffer.
    if (mode === 'external' && nextExternal && prevExternalFileKey !== nextExternalFileKey) {
      this.externalLoadKey = null
      this.externalLoadPromise = null
      this.externalFileKey = null
      this.stopExternal()
      this.externalPlayer?.disconnect()
      this.externalPlayer?.dispose()
      this.externalPlayer = null
    }

    if (this.audioMode !== 'external' || !this.externalAudio) {
      // Release any large decoded buffers when leaving external mode.
      this.externalLoadKey = null
      this.externalLoadPromise = null
      this.externalFileKey = null
      this.stopExternal()
      this.externalPlayer?.disconnect()
      this.externalPlayer?.dispose()
      this.externalPlayer = null
    }
  }

  getPositionSeconds(): number {
    return this.transport.seconds
  }

  setPositionSeconds(seconds: number): void {
    // Seeking while running would desync scheduled events/external audio; pause first.
    if (this.isPlaying()) this.pause()
    this.transport.seconds = Math.max(0, seconds)
  }

  isPlaying(): boolean {
    return this.transport.state === 'started'
  }

  getSpectrum(): Float32Array {
    return this.spectrumAnalyser.getValue() as Float32Array
  }

  getWaveform(): Float32Array {
    return this.waveformAnalyser.getValue() as Float32Array
  }

  private getOrCreateChannelFx(channel: number): ChannelFx {
    const ch = Number.isFinite(channel) ? Math.max(0, Math.min(15, channel | 0)) : 0
    const existing = this.channels.get(ch)
    if (existing) return existing

    const synth = new Tone.PolySynth({
      voice: Tone.Synth,
      maxPolyphony: 24,
      options: {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.002, decay: 0.12, sustain: 0.12, release: 0.12 },
      },
    })

    const vibrato = new Tone.Vibrato({ frequency: 5, depth: 0 })
    const tremolo = new Tone.Tremolo(9, 0).start()
    const panVol = new Tone.PanVol(0, 0)

    synth.connect(vibrato)
    vibrato.connect(tremolo)
    tremolo.connect(panVol)
    panVol.connect(this.output)

    const fx: ChannelFx = {
      synth,
      vibrato,
      tremolo,
      panVol,
      state: {
        pitchBendRangeSemitones: DEFAULT_PITCH_BEND_RANGE_SEMITONES,
        pitchBendValue: 0,
        modWheel: 0,
        aftertouch: 0,
        tremolo: 0,
        volume: 1,
        expression: 1,
        pan: 0,
        sustainDown: false,
        sustainedNotes: new Set<number>(),
      },
    }
    this.channels.set(ch, fx)
    return fx
  }

  private stopExternal(): void {
    if (this.externalPlayer) {
      this.externalPlayer.stop()
    }
  }

  private async ensureExternalLoaded(): Promise<void> {
    if (this.disposed) return
    if (this.audioMode !== 'external') return
    if (!this.externalAudio) throw new Error('External audio mode requires a file.')

    const file = this.externalAudio.file
    const fileKey = `${file.name}:${file.size}:${file.lastModified}`
    if (this.externalPlayer && this.externalFileKey === fileKey) {
      return
    }

    if (this.externalLoadPromise && this.externalLoadKey === fileKey) {
      await this.externalLoadPromise
      return
    }

    this.externalLoadKey = fileKey
    const loadPromise = (async () => {
      const url = URL.createObjectURL(file)
      const player = new Tone.Player({ autostart: false })
      player.connect(this.output)

      try {
        await player.load(url)
      } catch (err) {
        player.disconnect()
        player.dispose()
        URL.revokeObjectURL(url)
        throw err
      }

      // The URL is only needed for initial decoding.
      URL.revokeObjectURL(url)

      // If a newer load started, discard this one.
      if (this.disposed || this.externalLoadKey !== fileKey) {
        player.disconnect()
        player.dispose()
        return
      }

      this.stopExternal()
      this.externalPlayer?.dispose()

      this.externalPlayer = player
      this.externalFileKey = fileKey
    })().finally(() => {
      if (this.externalLoadPromise === loadPromise) this.externalLoadPromise = null
    })

    this.externalLoadPromise = loadPromise
    await loadPromise
  }

  private scheduleMidiAutomation(fromSeconds: number): void {
    const start = Math.max(0, fromSeconds)
    const now = Tone.now()

    const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
    const clamp11 = (v: number) => Math.max(-1, Math.min(1, v))

    const compactInPlace = (events: Array<{ time: number; value: number }>, minIntervalSec: number, valueEpsilon: number) => {
      if (events.length <= 1) return
      events.sort((a, b) => a.time - b.time)
      let write = 0
      for (const e of events) {
        if (write === 0) {
          events[write++] = e
          continue
        }

        const prev = events[write - 1]!
        if (Math.abs(e.value - prev.value) <= valueEpsilon) continue

        if (e.time - prev.time < minIntervalSec) {
          // Replace within the time bucket (keep the latest value).
          events[write - 1] = e
          continue
        }

        events[write++] = e
      }
      events.length = write
    }

    const setAtTime = (param: unknown, value: number, time: number) => {
      const p = param as { setValueAtTime?: (v: number, t: number) => void; value?: number } | null
      if (p?.setValueAtTime) {
        p.setValueAtTime(value, time)
        return
      }
      if (typeof p?.value === 'number') p.value = value
    }

    const linearGainToDb = (gain: number): number => {
      const g = Math.max(0, Math.min(1, gain))
      if (g <= 0.00001) return -80
      return 20 * Math.log10(g)
    }

    type CcEv = { time: number; controller: number; value: number }
    type Entry = {
      pitchBends: Array<{ time: number; value: number }>
      modWheel: Array<{ time: number; value: number }>
      aftertouch: Array<{ time: number; value: number }>
      tremolo: Array<{ time: number; value: number }>
      volume: Array<{ time: number; value: number }>
      expression: Array<{ time: number; value: number }>
      pan: Array<{ time: number; value: number }>
      sustain: Array<{ time: number; value: number }>
      rpn: CcEv[]
    }

    const byChannel = new Map<number, Entry>()
    const entryFor = (ch: number): Entry => {
      const key = Number.isFinite(ch) ? Math.max(0, Math.min(15, ch | 0)) : 0
      const existing = byChannel.get(key)
      if (existing) return existing
      const e: Entry = {
        pitchBends: [],
        modWheel: [],
        aftertouch: [],
        tremolo: [],
        volume: [],
        expression: [],
        pan: [],
        sustain: [],
        rpn: [],
      }
      byChannel.set(key, e)
      return e
    }

    // Gather events (merge across tracks; per-channel processing happens below).
    for (const tr of this.midi.tracks) {
      if (!tr.isDrum) {
        const e = entryFor(tr.channel)
        for (const pb of tr.pitchBends) e.pitchBends.push({ time: pb.time, value: pb.value })

        for (const cc of tr.controlChanges) {
          const v = cc.value
          if (cc.controller === 1) e.modWheel.push({ time: cc.time, value: v })
          else if (cc.controller === 92) e.tremolo.push({ time: cc.time, value: v })
          else if (cc.controller === 7) e.volume.push({ time: cc.time, value: v })
          else if (cc.controller === 11) e.expression.push({ time: cc.time, value: v })
          else if (cc.controller === 10) e.pan.push({ time: cc.time, value: v })
          else if (cc.controller === 64) e.sustain.push({ time: cc.time, value: v })
          else if (cc.controller === 101 || cc.controller === 100 || cc.controller === 6 || cc.controller === 38) {
            e.rpn.push({ time: cc.time, controller: cc.controller, value: v })
          }
        }
      }

      for (const at of tr.channelAftertouch) entryFor(at.channel).aftertouch.push({ time: at.time, value: at.value })
      for (const at of tr.noteAftertouch) entryFor(at.channel).aftertouch.push({ time: at.time, value: at.value })
    }

    const derivePitchBendRange = (events: CcEv[]): Array<{ time: number; value: number }> => {
      if (events.length === 0) return []
      const out: Array<{ time: number; value: number }> = []
      const priority = (cc: number) => (cc === 101 ? 0 : cc === 100 ? 1 : cc === 6 ? 2 : cc === 38 ? 3 : 4)
      // ControlChanges may be sorted by controller number; RPN semantics require MSB/LSB before Data Entry at the same time.
      events.sort((a, b) => a.time - b.time || priority(a.controller) - priority(b.controller))

      let rpnMsb = 127
      let rpnLsb = 127
      let semitones = DEFAULT_PITCH_BEND_RANGE_SEMITONES
      let cents = 0

      for (const e of events) {
        const v7 = Math.max(0, Math.min(127, Math.round(e.value * 127)))
        if (e.controller === 101) {
          rpnMsb = v7
          continue
        }
        if (e.controller === 100) {
          rpnLsb = v7
          continue
        }

        if (rpnMsb === 0 && rpnLsb === 0) {
          if (e.controller === 6) {
            semitones = v7
            out.push({ time: e.time, value: semitones + cents / 100 })
            continue
          }
          if (e.controller === 38) {
            cents = v7
            out.push({ time: e.time, value: semitones + cents / 100 })
          }
        }
      }

      return out
    }

    const scheduleLatestAndFuture = (
      events: Array<{ time: number; value: number }>,
      apply: (time: number, value: number) => void,
      compact?: { minIntervalSec: number; valueEpsilon: number },
    ) => {
      if (events.length === 0) return
      if (compact) compactInPlace(events, compact.minIntervalSec, compact.valueEpsilon)
      else events.sort((a, b) => a.time - b.time)

      let latest: { time: number; value: number } | null = null
      for (const e of events) {
        if (e.time <= start) latest = e
        else break
      }
      if (latest) apply(now, latest.value)

      for (const e of events) {
        if (e.time <= start) continue
        this.transport.scheduleOnce((time) => apply(time, e.value), e.time)
      }
    }

    for (const [ch, entry] of byChannel) {
      const fx = this.getOrCreateChannelFx(ch)
      const st = fx.state

      // Reset state on each playFrom() (seek) so stale state doesn't leak across restarts.
      st.pitchBendRangeSemitones = DEFAULT_PITCH_BEND_RANGE_SEMITONES
      st.pitchBendValue = 0
      st.modWheel = 0
      st.aftertouch = 0
      st.tremolo = 0
      st.volume = 1
      st.expression = 1
      st.pan = 0
      st.sustainDown = false
      st.sustainedNotes.clear()

      // Reset nodes immediately.
      fx.synth.set({ detune: 0 })
      setAtTime(fx.vibrato.depth, 0, now)
      setAtTime(fx.tremolo.depth, 0, now)
      setAtTime(fx.panVol.pan, 0, now)
      setAtTime(fx.panVol.volume, 0, now)

      const applyPitchBend = () => {
        fx.synth.set({ detune: st.pitchBendValue * st.pitchBendRangeSemitones * 100 })
      }

      const applyVibrato = (time: number) => {
        setAtTime(fx.vibrato.depth, clamp01(Math.max(st.modWheel, st.aftertouch)), time)
      }

      const applyVolume = (time: number) => {
        setAtTime(fx.panVol.volume, linearGainToDb(st.volume * st.expression), time)
      }

      const rangeEvents = derivePitchBendRange(entry.rpn)
      scheduleLatestAndFuture(rangeEvents, (_time, range) => {
        st.pitchBendRangeSemitones = Math.max(0, range)
        applyPitchBend()
      })

      scheduleLatestAndFuture(
        entry.pitchBends,
        (_time, v) => {
          st.pitchBendValue = clamp11(v)
          applyPitchBend()
        },
        { minIntervalSec: 1 / 60, valueEpsilon: 1 / 8192 },
      )

      scheduleLatestAndFuture(entry.modWheel, (time, v) => {
        st.modWheel = clamp01(v)
        applyVibrato(time)
      }, { minIntervalSec: 1 / 30, valueEpsilon: 1 / 127 })

      scheduleLatestAndFuture(entry.aftertouch, (time, v) => {
        st.aftertouch = clamp01(v)
        applyVibrato(time)
      }, { minIntervalSec: 1 / 30, valueEpsilon: 1 / 127 })

      scheduleLatestAndFuture(entry.tremolo, (time, v) => {
        st.tremolo = clamp01(v)
        setAtTime(fx.tremolo.depth, st.tremolo, time)
      }, { minIntervalSec: 1 / 30, valueEpsilon: 1 / 127 })

      scheduleLatestAndFuture(entry.volume, (time, v) => {
        st.volume = clamp01(v)
        applyVolume(time)
      }, { minIntervalSec: 1 / 30, valueEpsilon: 1 / 127 })

      scheduleLatestAndFuture(entry.expression, (time, v) => {
        st.expression = clamp01(v)
        applyVolume(time)
      }, { minIntervalSec: 1 / 30, valueEpsilon: 1 / 127 })

      scheduleLatestAndFuture(entry.pan, (time, v) => {
        st.pan = clamp11(v * 2 - 1)
        setAtTime(fx.panVol.pan, st.pan, time)
      }, { minIntervalSec: 1 / 30, valueEpsilon: 1 / 127 })

      scheduleLatestAndFuture(entry.sustain, (time, v) => {
        const down = v >= 0.5
        const wasDown = st.sustainDown
        st.sustainDown = down
        if (wasDown && !down) {
          for (const midi of st.sustainedNotes) {
            fx.synth.triggerRelease(midiToFreq(midi), time)
          }
          st.sustainedNotes.clear()
        }
      })
    }
  }

  private scheduleMidiNotes(fromSeconds: number): void {
    const start = Math.max(0, fromSeconds)

    const scheduleTrack = (track: MidiTrack) => {
      const isDrum = track.isDrum
      const fx = !isDrum ? this.getOrCreateChannelFx(track.channel) : null

      for (const note of track.notes) {
        if (note.endTime <= start) continue

        const velocity = Math.max(0, Math.min(1, note.velocity))
        const triggerTime = note.time < start ? start : note.time
        const endTime = note.endTime

        this.transport.scheduleOnce((time) => {
          if (this.audioMode !== 'midi') return

          if (isDrum) {
            this.drumKit.trigger(note.midi, time, velocity)
            return
          }

          const freq = midiToFreq(note.midi)
          const st = fx!.state
          // If a note was sustained and then re-attacked, release the sustained voice first.
          if (st.sustainedNotes.has(note.midi)) {
            st.sustainedNotes.delete(note.midi)
            fx!.synth.triggerRelease(freq, time)
          }
          fx!.synth.triggerAttack(freq, time, velocity)
        }, triggerTime)

        if (!isDrum) {
          this.transport.scheduleOnce((time) => {
            if (this.audioMode !== 'midi') return
            const st = fx!.state
            const freq = midiToFreq(note.midi)
            if (st.sustainDown) {
              st.sustainedNotes.add(note.midi)
              return
            }
            fx!.synth.triggerRelease(freq, time)
          }, endTime)
        }
      }
    }

    for (const track of this.midi.tracks) scheduleTrack(track)
  }

  private startExternalAudio(fromSeconds: number, startAt: number): void {
    if (this.audioMode !== 'external') return
    if (!this.externalPlayer || !this.externalAudio) return

    const offsetSeconds = this.externalAudio.offsetMs / 1000
    const audioPos = fromSeconds + offsetSeconds

    if (audioPos >= 0) {
      this.externalPlayer.start(startAt, audioPos)
    } else {
      this.externalPlayer.start(startAt + -audioPos, 0)
    }
  }

  async playFrom(fromSeconds: number): Promise<void> {
    if (this.disposed) return
    const gen = ++this.playGeneration
    await this.ensureStarted()
    if (this.disposed) return
    if (gen !== this.playGeneration) return

    const start = Math.max(0, fromSeconds)

    // Stop all scheduled events and restart cleanly.
    this.transport.stop()
    this.transport.cancel(0)
    this.stopExternal()
    this.releaseAllVoices(Tone.now())

    // Restore master volume immediately (we may have muted on pause).
    this.output.gain.cancelScheduledValues(Tone.now())
    this.output.gain.setValueAtTime(1, Tone.now())

    if (this.audioMode === 'external') {
      await this.ensureExternalLoaded()
      if (gen !== this.playGeneration) return
    }

    const startAt = Tone.now()
    if (this.disposed) return
    if (gen !== this.playGeneration) return
    if (this.audioMode === 'midi') {
      this.scheduleMidiAutomation(start)
      this.scheduleMidiNotes(start)
    } else {
      this.startExternalAudio(start, startAt)
    }

    if (this.disposed) return
    if (gen !== this.playGeneration) return
    this.transport.start(startAt, start)
  }

  pause(): void {
    // Invalidate any in-flight playFrom() continuations.
    this.playGeneration++
    this.transport.pause()
    this.transport.cancel(0)
    this.stopExternal()
    this.releaseAllVoices(Tone.now())

    // Hard-mute to avoid lingering scheduled releases.
    this.output.gain.cancelScheduledValues(Tone.now())
    this.output.gain.setValueAtTime(0, Tone.now())
  }

  dispose(): void {
    this.disposed = true
    this.playGeneration++
    this.pause()
    this.transport.stop()
    this.transport.cancel(0)

    this.externalPlayer?.dispose()
    this.externalPlayer = null

    if (this.externalObjectUrl) URL.revokeObjectURL(this.externalObjectUrl)
    this.externalObjectUrl = null
    this.externalFileKey = null

    this.drumKit.dispose()
    for (const fx of this.channels.values()) {
      fx.tremolo.dispose()
      fx.vibrato.dispose()
      fx.panVol.dispose()
      fx.synth.dispose()
    }
    this.channels.clear()
    this.spectrumAnalyser.dispose()
    this.waveformAnalyser.dispose()
    this.output.dispose()
  }
}

