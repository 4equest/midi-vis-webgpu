import { describe, expect, it } from 'vitest'

import { pickDefaultDisplayTrackIndices } from '../src/lib/midi/trackSelect'

describe('pickDefaultDisplayTrackIndices', () => {
  it('picks the top tracks by note count (ties by track index)', () => {
    const tracks = [
      { index: 0, notes: new Array(10) },
      { index: 1, notes: new Array(2) },
      { index: 2, notes: new Array(10) },
      { index: 3, notes: new Array(0) },
    ] as any

    expect(pickDefaultDisplayTrackIndices(tracks, 2)).toEqual([0, 2])
  })

  it('never returns more than maxTracksToDisplay and clamps invalid max', () => {
    const tracks = [
      { index: 0, notes: new Array(1) },
      { index: 1, notes: new Array(1) },
      { index: 2, notes: new Array(1) },
    ] as any

    expect(pickDefaultDisplayTrackIndices(tracks, 1)).toHaveLength(1)
    expect(pickDefaultDisplayTrackIndices(tracks, 0)).toHaveLength(1)
    expect(pickDefaultDisplayTrackIndices(tracks, Number.NaN)).toHaveLength(2)
  })
})

