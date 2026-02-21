function containsJapaneseLikeChars(s: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(s)
}

export function decodeBestEffortMidiText(raw: string): string {
  const cleaned = raw.replace(/\0/g, '')
  if (cleaned.trim().length === 0) return ''
  if (containsJapaneseLikeChars(cleaned)) return cleaned

  // Many MIDI files store meta-text in Shift-JIS (or similar). Some parsers decode bytes as latin1,
  // which makes Japanese names look garbled but still preserves the original byte values.
  let allLatin1 = true
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned.charCodeAt(i) > 0xff) {
      allLatin1 = false
      break
    }
  }
  if (!allLatin1) return cleaned
  if (typeof TextDecoder === 'undefined') return cleaned

  const bytes = new Uint8Array(cleaned.length)
  for (let i = 0; i < cleaned.length; i++) bytes[i] = cleaned.charCodeAt(i) & 0xff

  // Prefer valid UTF-8 when possible. This prevents false-positive Shift-JIS decodes (e.g. UTF-8 "♪").
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0/g, '')
    if (utf8.trim().length > 0) return utf8
  } catch {
    // fall through
  }

  const decode = (enc: string): string => {
    try {
      return new TextDecoder(enc as any, { fatal: false }).decode(bytes).replace(/\0/g, '')
    } catch {
      return ''
    }
  }

  const candidates = [cleaned, decode('utf-8'), decode('windows-1252'), decode('shift_jis'), decode('windows-31j')].filter(
    (s) => s.length > 0,
  )

  const score = (s: string): number => {
    const len = Math.max(1, s.length)
    let japanese = 0
    let replacement = 0
    let control = 0

    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i)
      if (code === 0xfffd) replacement++
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) control++
      if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff)) japanese++
    }

    let sc = 0
    if (japanese > 0) {
      const ratio = japanese / len
      // Single accidental CJK chars are common in wrong Shift-JIS decodes; penalize low-ratio hits.
      sc += japanese >= 2 || ratio >= 0.3 ? 10 : -5
    }
    sc -= replacement * 5
    sc -= control * 2
    return sc
  }

  let best = cleaned
  let bestScore = score(cleaned)
  for (const c of candidates) {
    const s = score(c)
    if (s > bestScore) {
      bestScore = s
      best = c
    }
  }

  return best
}

