import { describe, expect, it } from 'vitest'

import { MidiTiming } from '../src/lib/midi/timing'

describe('MidiTiming', () => {
  it('converts ticks<->seconds with tempo changes', () => {
    const ppq = 480
    const timing = new MidiTiming({
      ppq,
      durationTicks: 480 * 8,
      tempos: [
        { ticks: 0, bpm: 120 },
        { ticks: 480 * 4, bpm: 60 },
      ],
      timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
    })

    // 4 quarters at 120bpm => 2 seconds
    expect(timing.ticksToSeconds(480 * 4)).toBeCloseTo(2, 6)
    // then 1 quarter at 60bpm => +1 second
    expect(timing.ticksToSeconds(480 * 5)).toBeCloseTo(3, 6)

    // 2.5s => 4 quarters (2s) + 0.5s into the 60bpm segment => 0.5 quarter => 240 ticks
    expect(timing.secondsToTicks(2.5)).toBe(480 * 4 + 240)
  })

  it('computes bar/beat/subBeat1000 with time signature changes', () => {
    const ppq = 480
    const timing = new MidiTiming({
      ppq,
      durationTicks: 7000,
      tempos: [{ ticks: 0, bpm: 120 }],
      timeSignatures: [
        { ticks: 0, timeSignature: [4, 4] },
        { ticks: 480 * 4 * 2, timeSignature: [3, 4] }, // after 2 bars of 4/4
      ],
    })

    // bar starts
    expect(timing.getBarStartTick(1)).toBe(0)
    expect(timing.getBarStartTick(2)).toBe(480 * 4)
    expect(timing.getBarStartTick(3)).toBe(480 * 4 * 2)
    expect(timing.getBarStartTick(4)).toBe(480 * 4 * 2 + 480 * 3)

    // 4/4 bar 2, beat 3
    expect(timing.getBarBeatAtTicks(480 * 4 + 480 * 2)).toMatchObject({ bar: 2, beat: 3 })

    // 3/4 bar 3, beat 3
    expect(timing.getBarBeatAtTicks(480 * 4 * 2 + 480 * 2)).toMatchObject({ bar: 3, beat: 3 })

    // subBeat at half-beat (240/480 => 500)
    const halfBeat = timing.getBarBeatAtTicks(480 * 4 + 240)
    expect(halfBeat).toMatchObject({ bar: 2, beat: 1 })
    expect(halfBeat.subBeat1000).toBe(500)
  })

  it('computes page tick ranges by bar count', () => {
    const ppq = 480
    const timing = new MidiTiming({
      ppq,
      durationTicks: 10_000,
      tempos: [{ ticks: 0, bpm: 120 }],
      timeSignatures: [
        { ticks: 0, timeSignature: [4, 4] },
        { ticks: 480 * 4 * 2, timeSignature: [3, 4] },
      ],
    })

    const pageBars = 2
    const { pageIndex, startBar, endBar } = timing.getPageRangeForBar(3, pageBars)
    expect(pageIndex).toBe(1)
    expect(startBar).toBe(3)
    expect(endBar).toBe(4)

    const range = timing.getPageTickRange(pageIndex, pageBars)
    expect(range.startTick).toBe(480 * 4 * 2)
    expect(range.endTick).toBe(480 * 4 * 2 + 480 * 3 * 2)
  })

  it('round-trips ticks<->seconds at tick boundaries (avoid float underflow)', () => {
    const timing = new MidiTiming({
      ppq: 480,
      durationTicks: 20_000,
      tempos: [{ ticks: 0, bpm: 30 }],
      timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
    })

    for (const t of [0, 1, 2, 123, 245, 490, 999, 1000, 12_345]) {
      const s = timing.ticksToSeconds(t)
      expect(timing.secondsToTicks(s)).toBe(t)
    }
  })

  it('uses MIDI defaults before the first tempo event when it is not at tick 0', () => {
    const ppq = 480
    const timing = new MidiTiming({
      ppq,
      durationTicks: 4000,
      tempos: [{ ticks: 480, bpm: 60 }],
      timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
    })

    // Before the first tempo meta-event, MIDI default tempo is 120bpm.
    expect(timing.ticksToSeconds(240)).toBeCloseTo(0.25, 6)
  })

  it('uses MIDI defaults before the first time signature event when it is not at tick 0', () => {
    const ppq = 480
    const timing = new MidiTiming({
      ppq,
      durationTicks: 10_000,
      tempos: [{ ticks: 0, bpm: 120 }],
      timeSignatures: [{ ticks: 480 * 4, timeSignature: [3, 4] }],
    })

    expect(timing.getBarBeatAtTicks(0).timeSignature).toEqual([4, 4])
    expect(timing.getBarStartTick(2)).toBe(480 * 4)
  })

  it('derives bar/page seek step sizes from actual measure boundaries', () => {
    const ppq = 480
    const timing = new MidiTiming({
      ppq,
      durationTicks: 10_000,
      tempos: [{ ticks: 0, bpm: 120 }],
      timeSignatures: [
        { ticks: 0, timeSignature: [4, 4] },
        { ticks: 480 * 4, timeSignature: [3, 4] }, // bar boundary: bar2 becomes 3/4
      ],
    })

    const pageBars = 2
    const pageRange = timing.getPageTickRange(0, pageBars)
    const step = timing.getSeekStepTicksAtTicks(0, pageBars)

    expect(step.bar).toBe(timing.getBarStartTick(2) - timing.getBarStartTick(1))
    expect(step.page).toBe(pageRange.endTick - pageRange.startTick)
    expect(step.page).toBe(480 * 4 + 480 * 3)
  })

  it('sanitizes NaN inputs for bar/page helpers', () => {
    const timing = new MidiTiming({
      ppq: 480,
      durationTicks: 480 * 8,
      tempos: [{ ticks: 0, bpm: 120 }],
      timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
    })

    expect(timing.ticksToSeconds(Number.NaN)).toBe(0)
    expect(timing.secondsToTicks(Number.NaN)).toBe(0)
    expect(timing.getBarBeatAtTicks(Number.NaN)).toMatchObject({ bar: 1, beat: 1, subBeat1000: 0 })

    // Infinity should clamp to the end.
    expect(timing.ticksToSeconds(Number.POSITIVE_INFINITY)).toBeCloseTo(timing.durationSeconds, 6)
    expect(timing.secondsToTicks(Number.POSITIVE_INFINITY)).toBe(timing.durationTicks)

    expect(timing.getBarStartTick(Number.NaN)).toBe(0)
    expect(timing.getPageTickRange(0, Number.NaN)).toEqual({ startTick: 0, endTick: 480 * 4 })
    expect(timing.getSeekStepTicksAtTicks(0, Number.NaN)).toMatchObject({ beat: 480, bar: 480 * 4, page: 480 * 4 })
  })

  it('falls back to defaults for invalid fractional time signatures that floor to zero', () => {
    const timing = new MidiTiming({
      ppq: 480,
      durationTicks: 480 * 8,
      tempos: [{ ticks: 0, bpm: 120 }],
      timeSignatures: [{ ticks: 0, timeSignature: [0.5, 4] }],
    })

    expect(timing.getBarBeatAtTicks(0).timeSignature).toEqual([4, 4])
    expect(timing.getBarStartTick(2)).toBe(480 * 4)
  })
})

