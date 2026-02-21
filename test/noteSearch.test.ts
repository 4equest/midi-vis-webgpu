import { describe, expect, it } from 'vitest'

import { findStartIndexIncludingSustains } from '../src/lib/midi/noteSearch'

describe('findStartIndexIncludingSustains', () => {
  it('includes long sustained notes even if nearer short notes end before the window start', () => {
    const notes = [
      { ticks: 0, endTicks: 10_000 }, // long pedal
      { ticks: 50, endTicks: 60 }, // short
      { ticks: 80, endTicks: 90 }, // short
      { ticks: 100, endTicks: 200 }, // starts at the window
    ]

    expect(findStartIndexIncludingSustains(notes, 100)).toBe(0)
  })

  it('returns the lower-bound index when there are no sustaining notes', () => {
    const notes = [
      { ticks: 0, endTicks: 10 },
      { ticks: 20, endTicks: 30 },
      { ticks: 40, endTicks: 50 },
      { ticks: 60, endTicks: 70 },
    ]

    expect(findStartIndexIncludingSustains(notes, 35)).toBe(2)
  })
})

