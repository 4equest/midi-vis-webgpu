import type { Midi } from '@tonejs/midi'

export type TimeSignature = readonly [number, number]

export interface TempoEvent {
  ticks: number
  bpm: number
}

export interface TimeSignatureEvent {
  ticks: number
  timeSignature: TimeSignature
}

export interface MidiNote {
  midi: number
  velocity: number
  ticks: number
  durationTicks: number
  endTicks: number
  time: number
  duration: number
  endTime: number
}

export interface MidiPitchBendEvent {
  ticks: number
  time: number
  /** Normalized bend amount, typically in [-1, 1]. */
  value: number
}

export interface MidiControlChangeEvent {
  controller: number
  ticks: number
  time: number
  /** Normalized controller value in [0, 1]. */
  value: number
}

export interface MidiChannelAftertouchEvent {
  channel: number
  ticks: number
  time: number
  /** Normalized pressure in [0, 1]. */
  value: number
}

export interface MidiNoteAftertouchEvent {
  channel: number
  ticks: number
  time: number
  midi: number
  /** Normalized pressure in [0, 1]. */
  value: number
}

export interface MidiTrack {
  index: number
  name: string
  channel: number
  isDrum: boolean
  notes: MidiNote[]
  pitchBends: MidiPitchBendEvent[]
  controlChanges: MidiControlChangeEvent[]
  channelAftertouch: MidiChannelAftertouchEvent[]
  noteAftertouch: MidiNoteAftertouchEvent[]
}

export interface MidiParsed {
  midi: Midi
  ppq: number
  durationSeconds: number
  durationTicks: number
  tempos: TempoEvent[]
  timeSignatures: TimeSignatureEvent[]
  tracks: MidiTrack[]
}

