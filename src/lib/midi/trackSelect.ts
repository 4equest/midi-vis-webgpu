import type { MidiTrack } from './types'

export function pickDefaultDisplayTrackIndices(tracks: readonly MidiTrack[], maxTracksToDisplay: number): number[] {
  const max = Number.isFinite(maxTracksToDisplay) ? Math.max(1, Math.floor(maxTracksToDisplay)) : 2

  return tracks
    .map((t) => ({ index: t.index, noteCount: t.notes.length }))
    .filter((t) => t.noteCount > 0)
    .sort((a, b) => b.noteCount - a.noteCount || a.index - b.index)
    .slice(0, max)
    .map((t) => t.index)
}

