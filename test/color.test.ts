import { describe, expect, it } from 'vitest'

import { parseHexRgb, rgbaCssFromHex, rgb01FromHex } from '../src/lib/visual/color'

describe('visual/color', () => {
  it('parseHexRgb parses 6-digit hex', () => {
    expect(parseHexRgb('#ff00aa')).toEqual({ r: 255, g: 0, b: 170 })
    expect(parseHexRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 })
  })

  it('parseHexRgb returns null on invalid', () => {
    expect(parseHexRgb('#xyz')).toBeNull()
    expect(parseHexRgb('#fff')).toBeNull()
    expect(parseHexRgb('')).toBeNull()
  })

  it('rgb01FromHex returns fallback on invalid', () => {
    expect(rgb01FromHex('nope', [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3])
  })

  it('rgbaCssFromHex clamps alpha', () => {
    expect(rgbaCssFromHex('#000000', 2, 'fallback')).toBe('rgba(0,0,0,1)')
    expect(rgbaCssFromHex('#ffffff', -1, 'fallback')).toBe('rgba(255,255,255,0)')
  })

  it('rgbaCssFromHex returns fallback on invalid', () => {
    expect(rgbaCssFromHex('bad', 0.5, 'fallback')).toBe('fallback')
  })
})

