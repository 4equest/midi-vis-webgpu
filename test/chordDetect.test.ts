import { describe, expect, it } from 'vitest'

import { detectChordNameFromMidiNotes } from '../src/lib/chords/detectChord'

describe('detectChordNameFromMidiNotes', () => {
  it('returns N.C. for no notes', () => {
    expect(detectChordNameFromMidiNotes([])).toBe('N.C.')
  })

  it('returns pitch class name for a single note', () => {
    expect(detectChordNameFromMidiNotes([60])).toBe('C')
  })

  it('detects common chords', () => {
    expect(detectChordNameFromMidiNotes([60, 64, 67])).toBe('CM')
    expect(detectChordNameFromMidiNotes([62, 65, 69, 72])).toBe('Dm7')
    expect(detectChordNameFromMidiNotes([60, 64, 67, 71])).toBe('Cmaj7')
  })

  it('does not overuse slash chords for common inversions (keeps display stable)', () => {
    // Cmaj7 chord tones with E in the bass.
    expect(detectChordNameFromMidiNotes([64, 67, 71, 72])).toBe('Cmaj7')
  })

  it('is stable regardless of input note ordering', () => {
    // Same pitch set as the previous test, but shuffled (bass is still E=64).
    expect(detectChordNameFromMidiNotes([72, 71, 67, 64])).toBe('Cmaj7')
  })

  it('adds slash bass when the bass is outside core chord tones (e.g. 9th in bass)', () => {
    // C9 chord tones with D in the bass.
    expect(detectChordNameFromMidiNotes([50, 60, 64, 67, 70])).toBe('C9/D')
  })

  it('adds slash bass for add9 chords when the 9th is in bass', () => {
    // CMadd9 chord tones with D in the bass.
    expect(detectChordNameFromMidiNotes([50, 60, 64, 67])).toBe('CMadd9/D')
  })

  it('handles altered/jazz-like tensions from pitch classes', () => {
    // C7b9 -> C E G Bb Db
    expect(detectChordNameFromMidiNotes([60, 64, 67, 70, 61])).toBe('C7b9')
  })

  it('falls back to a best-effort chord name when the full pitch set is not detectable', () => {
    // Pitch classes: C# D D# F G# B (Chord.detect returns [] for the full set).
    expect(detectChordNameFromMidiNotes([49, 50, 51, 53, 56, 59])).toBe('C#9')
  })
})

