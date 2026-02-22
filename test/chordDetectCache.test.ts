import { describe, expect, it, vi } from 'vitest'

describe('detectChordNameFromMidiNotes (cache)', () => {
  it('memoizes Chord.detect for repeated calls with the same pitch class set + bass', async () => {
    vi.resetModules()

    const tonal = await import('@tonaljs/tonal')
    const spy = vi.spyOn(tonal.Chord, 'detect')

    try {
      const { detectChordNameFromMidiNotes } = await import('../src/lib/chords/detectChord')

      // Use a pitch set not covered by other tests to keep this self-contained.
      const notes = [62, 66, 69, 72, 76] // D F# A C E => D9-ish

      detectChordNameFromMidiNotes(notes)
      detectChordNameFromMidiNotes(notes)

      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})

