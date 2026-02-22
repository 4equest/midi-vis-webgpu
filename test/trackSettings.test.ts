import { describe, expect, it } from 'vitest'

import { getChordTrackIndices, getDisplayTrackIndices } from '../src/lib/state/trackSettings'

describe('trackSettings helpers', () => {
  it('separates display tracks from chord tracks', () => {
    const settings = [
      { trackIndex: 0, enabled: true, chordEnabled: false },
      { trackIndex: 1, enabled: false, chordEnabled: true },
      { trackIndex: 2, enabled: true, chordEnabled: true },
    ]

    expect(getDisplayTrackIndices(settings)).toEqual([0, 2])
    expect(getChordTrackIndices(settings)).toEqual([1, 2])
  })
})

