export interface NoteTickRangeLike {
  ticks: number
  endTicks: number
}

export function lowerBoundByStartTick<T extends { ticks: number }>(notes: readonly T[], tick: number): number {
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((notes[mid]?.ticks ?? 0) < tick) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Given notes sorted by `ticks` (start tick), returns the earliest index that might overlap `startTick`.
 * This includes notes that start before `startTick` but sustain into it.
 */
export function findStartIndexIncludingSustains<T extends NoteTickRangeLike>(
  notes: readonly T[],
  startTick: number,
): number {
  let idx = lowerBoundByStartTick(notes, startTick)
  for (let j = idx - 1; j >= 0; j--) {
    if ((notes[j]?.endTicks ?? 0) > startTick) idx = j
  }
  return idx
}

