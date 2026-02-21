import { describe, expect, it } from 'vitest'

import { decodeBestEffortMidiText } from '../src/lib/midi/textDecode'

function latin1StringFromBytes(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return s
}

describe('decodeBestEffortMidiText', () => {
  it('prefers valid UTF-8 over latin1 mojibake (Flûte)', () => {
    const bytes = new TextEncoder().encode('Flûte')
    const raw = latin1StringFromBytes(bytes) // looks like "FlÃ»te"
    expect(decodeBestEffortMidiText(raw)).toBe('Flûte')
  })

  it('does not corrupt already-decoded latin1 text (Flûte)', () => {
    expect(decodeBestEffortMidiText('Flûte')).toBe('Flûte')
  })

  it('prefers valid UTF-8 over false-positive Shift-JIS (Track ♪)', () => {
    const bytes = new TextEncoder().encode('Track ♪')
    const raw = latin1StringFromBytes(bytes)
    expect(decodeBestEffortMidiText(raw)).toBe('Track ♪')
  })

  it('decodes Shift-JIS bytes (ピアノ)', () => {
    const bytes = Uint8Array.from([0x83, 0x73, 0x83, 0x41, 0x83, 0x6d])
    const raw = latin1StringFromBytes(bytes)
    expect(decodeBestEffortMidiText(raw)).toBe('ピアノ')
  })

  it('does not trim away leading/trailing whitespace', () => {
    expect(decodeBestEffortMidiText('  Track  ')).toBe('  Track  ')
  })

  it('gracefully handles missing TextDecoder', () => {
    const orig = globalThis.TextDecoder
    // @ts-expect-error - runtime override for test
    globalThis.TextDecoder = undefined
    try {
      const bytes = new TextEncoder().encode('Flûte')
      const raw = latin1StringFromBytes(bytes)
      expect(decodeBestEffortMidiText(raw)).toBe(raw)
    } finally {
      globalThis.TextDecoder = orig
    }
  })
})

