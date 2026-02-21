import { describe, expect, it } from 'vitest'

import { easeOutExpo } from '../src/lib/visual/easing'

describe('easeOutExpo', () => {
  it('clamps endpoints', () => {
    expect(easeOutExpo(-1)).toBe(0)
    expect(easeOutExpo(0)).toBe(0)
    expect(easeOutExpo(1)).toBe(1)
    expect(easeOutExpo(2)).toBe(1)
  })

  it('is monotonic increasing in [0,1]', () => {
    const samples = Array.from({ length: 20 }, (_, i) => easeOutExpo(i / 19))
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!)
    }
  })

  it('eases out (fast start, slow end)', () => {
    const a = easeOutExpo(0.1) - easeOutExpo(0.0)
    const b = easeOutExpo(1.0) - easeOutExpo(0.9)
    expect(a).toBeGreaterThan(b)
  })
})

