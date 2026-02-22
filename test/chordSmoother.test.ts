import { describe, expect, it } from 'vitest'

import { ChordSmoother } from '../src/lib/chords/chordSmoother'

describe('ChordSmoother', () => {
  it('switches immediately from N.C. to a chord', () => {
    const s = new ChordSmoother({ switchDelayMs: 200, ncDelayMs: 300 })
    expect(s.update('Cmaj7', 0)).toBe('Cmaj7')
  })

  it('debounces chord changes', () => {
    const s = new ChordSmoother({ switchDelayMs: 200, ncDelayMs: 300 }, 'Cmaj7')
    expect(s.update('Dm7', 0)).toBe('Cmaj7')
    expect(s.update('Dm7', 199)).toBe('Cmaj7')
    expect(s.update('Dm7', 200)).toBe('Dm7')
  })

  it('holds last chord briefly before switching to N.C.', () => {
    const s = new ChordSmoother({ switchDelayMs: 200, ncDelayMs: 300 }, 'Cmaj7')
    expect(s.update('N.C.', 0)).toBe('Cmaj7')
    expect(s.update('N.C.', 299)).toBe('Cmaj7')
    expect(s.update('N.C.', 300)).toBe('N.C.')
  })

  it('resets candidate when raw chord changes again', () => {
    const s = new ChordSmoother({ switchDelayMs: 200, ncDelayMs: 300 }, 'Cmaj7')
    expect(s.update('Dm7', 0)).toBe('Cmaj7')
    expect(s.update('Em7', 100)).toBe('Cmaj7')
    expect(s.update('Em7', 299)).toBe('Cmaj7')
    expect(s.update('Em7', 300)).toBe('Em7')
  })
})

