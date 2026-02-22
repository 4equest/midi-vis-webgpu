export interface TrackSettingLike {
  trackIndex: number
  enabled: boolean
  chordEnabled: boolean
}

export function getDisplayTrackIndices(settings: readonly TrackSettingLike[]): number[] {
  return settings.filter((s) => s.enabled).map((s) => s.trackIndex)
}

export function getChordTrackIndices(settings: readonly TrackSettingLike[]): number[] {
  return settings.filter((s) => s.chordEnabled).map((s) => s.trackIndex)
}

