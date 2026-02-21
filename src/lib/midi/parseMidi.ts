import { Midi } from '@tonejs/midi'
import { parseMidi as parseMidiFile } from 'midi-file'

import { decodeBestEffortMidiText } from './textDecode'
import type { MidiParsed, MidiTrack, TempoEvent, TimeSignatureEvent } from './types'

function normalizeTempos(tempos: { ticks: number; bpm: number }[]): TempoEvent[] {
  if (tempos.length > 0) return tempos.map((t) => ({ ticks: t.ticks, bpm: t.bpm }))
  return [{ ticks: 0, bpm: 120 }]
}

function normalizeTimeSignatures(
  timeSignatures: { ticks: number; timeSignature: number[] }[],
): TimeSignatureEvent[] {
  if (timeSignatures.length > 0) {
    return timeSignatures.map((ts) => ({
      ticks: ts.ticks,
      timeSignature: [ts.timeSignature[0] ?? 4, ts.timeSignature[1] ?? 4] as const,
    }))
  }
  return [{ ticks: 0, timeSignature: [4, 4] as const }]
}

export function parseMidiArrayBuffer(arrayBuffer: ArrayBuffer): MidiParsed {
  const bytes = new Uint8Array(arrayBuffer)
  const midi = new Midi(arrayBuffer)
  const raw = parseMidiFile(bytes)

  const tempos = normalizeTempos(midi.header.tempos)
  const timeSignatures = normalizeTimeSignatures(midi.header.timeSignatures)

  const aftertouchByTrackIndex = raw.tracks.map((events) => {
    let ticks = 0
    const channelAftertouch: MidiTrack['channelAftertouch'] = []
    const noteAftertouch: MidiTrack['noteAftertouch'] = []

    for (const ev of events) {
      ticks += ev.deltaTime
      if (ev.type === 'channelAftertouch') {
        channelAftertouch.push({
          channel: ev.channel,
          ticks,
          time: midi.header.ticksToSeconds(ticks),
          value: Math.max(0, Math.min(1, ev.amount / 127)),
        })
        continue
      }
      if (ev.type === 'noteAftertouch') {
        noteAftertouch.push({
          channel: ev.channel,
          midi: ev.noteNumber,
          ticks,
          time: midi.header.ticksToSeconds(ticks),
          value: Math.max(0, Math.min(1, ev.amount / 127)),
        })
      }
    }

    return { channelAftertouch, noteAftertouch }
  })

  const tracks: MidiTrack[] = midi.tracks.map((t, index) => {
    const controlChanges: MidiTrack['controlChanges'] = []
    for (const [k, list] of Object.entries((t as unknown as { controlChanges?: Record<string, unknown> }).controlChanges ?? {})) {
      const controller = Number.parseInt(k, 10)
      if (!Number.isFinite(controller)) continue
      if (!Array.isArray(list)) continue
      for (const ev of list as Array<{ ticks: number; time: number; value: number }>) {
        controlChanges.push({ controller, ticks: ev.ticks, time: ev.time, value: ev.value })
      }
    }
    controlChanges.sort((a, b) => a.time - b.time || a.ticks - b.ticks || a.controller - b.controller)

    const pitchBends: MidiTrack['pitchBends'] = (t as unknown as { pitchBends?: Array<{ ticks: number; time: number; value: number }> }).pitchBends
      ? (t as unknown as { pitchBends: Array<{ ticks: number; time: number; value: number }> }).pitchBends.map((pb) => ({
          ticks: pb.ticks,
          time: pb.time,
          value: pb.value,
        }))
      : []
    pitchBends.sort((a, b) => a.time - b.time || a.ticks - b.ticks)

    const at = aftertouchByTrackIndex[index] ?? { channelAftertouch: [], noteAftertouch: [] }

    return {
      index,
      name: decodeBestEffortMidiText(t.name ?? ''),
      channel: t.channel ?? 0,
      // MIDI standard: channel 10 is drums (0-based channel 9).
      isDrum: (t.channel ?? 0) === 9,
      notes: t.notes.map((n) => ({
        midi: n.midi,
        velocity: n.velocity,
        ticks: n.ticks,
        durationTicks: n.durationTicks,
        endTicks: n.ticks + n.durationTicks,
        time: n.time,
        duration: n.duration,
        endTime: n.time + n.duration,
      })),
      pitchBends,
      controlChanges,
      channelAftertouch: at.channelAftertouch,
      noteAftertouch: at.noteAftertouch,
    }
  })

  return {
    midi,
    ppq: midi.header.ppq,
    durationSeconds: midi.duration,
    durationTicks: midi.durationTicks,
    tempos,
    timeSignatures,
    tracks,
  }
}

