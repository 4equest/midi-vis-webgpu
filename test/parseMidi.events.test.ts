import { describe, expect, it } from 'vitest'

import { parseMidiArrayBuffer } from '../src/lib/midi/parseMidi'

function makeMidiWithPitchBendAndCc(): ArrayBuffer {
  // SMF format 0, 1 track, 480 ppq, tempo 120, pitch bend + CC + aftertouch + a single C4 quarter note.
  const bytes = [
    // MThd header
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    // MTrk chunk header (length 0x23)
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x23,
    // delta=0 tempo
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    // delta=0 pitch bend (max up)
    0x00, 0xe0, 0x7f, 0x7f,
    // delta=0 CC1 mod wheel = 127
    0x00, 0xb0, 0x01, 0x7f,
    // delta=0 channel aftertouch = 64
    0x00, 0xd0, 0x40,
    // delta=0 note aftertouch (C4) = 32
    0x00, 0xa0, 0x3c, 0x20,
    // delta=0 note on (C4)
    0x00, 0x90, 0x3c, 0x40,
    // delta=480 note off
    0x83, 0x60, 0x80, 0x3c, 0x00,
    // delta=0 end of track
    0x00, 0xff, 0x2f, 0x00,
  ]
  return Uint8Array.from(bytes).buffer
}

describe('parseMidiArrayBuffer (events)', () => {
  it('parses pitch bend + control change events', () => {
    const parsed = parseMidiArrayBuffer(makeMidiWithPitchBendAndCc())
    expect(parsed.tracks.length).toBe(1)

    const tr = parsed.tracks[0]!
    expect(tr.pitchBends.length).toBe(1)
    expect(tr.pitchBends[0]!.ticks).toBe(0)
    expect(tr.pitchBends[0]!.time).toBe(0)
    expect(tr.pitchBends[0]!.value).toBeGreaterThan(0.99)

    const cc1 = tr.controlChanges.find((c) => c.controller === 1)
    expect(cc1).toBeTruthy()
    expect(cc1?.ticks).toBe(0)
    expect(cc1?.time).toBe(0)
    expect(cc1?.value).toBe(1)

    expect(tr.channelAftertouch.length).toBe(1)
    expect(tr.channelAftertouch[0]!.channel).toBe(0)
    expect(tr.channelAftertouch[0]!.ticks).toBe(0)
    expect(tr.channelAftertouch[0]!.time).toBe(0)
    expect(tr.channelAftertouch[0]!.value).toBeCloseTo(64 / 127, 6)

    expect(tr.noteAftertouch.length).toBe(1)
    expect(tr.noteAftertouch[0]!.channel).toBe(0)
    expect(tr.noteAftertouch[0]!.midi).toBe(60)
    expect(tr.noteAftertouch[0]!.ticks).toBe(0)
    expect(tr.noteAftertouch[0]!.time).toBe(0)
    expect(tr.noteAftertouch[0]!.value).toBeCloseTo(32 / 127, 6)
  })
})

