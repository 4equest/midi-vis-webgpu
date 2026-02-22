import { Chord, Note } from '@tonaljs/tonal'

const PC_SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

function pc(n: number): number {
  return ((n % 12) + 12) % 12
}

function pcName(pcNum: number): string {
  return PC_SHARPS[pc(pcNum)] ?? 'C'
}

function orderedUniquePitchClassesByBass(midiNotes: number[]): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const n of midiNotes) {
    const p = pc(n)
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

function setEquals(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

const CHORD_CACHE = new Map<number, string>()

export function detectChordNameFromMidiNotes(activeMidiNotes: number[]): string {
  const midiNotes = activeMidiNotes.filter((n) => Number.isFinite(n)).map((n) => Math.trunc(n))
  if (midiNotes.length === 0) return 'N.C.'

  // Make chord detection stable regardless of input ordering.
  midiNotes.sort((a, b) => a - b)

  const bassMidi = midiNotes[0]!
  const bassPc = pc(bassMidi)

  let mask = 0
  for (const n of midiNotes) mask |= 1 << pc(n)
  const key = (bassPc << 12) | mask
  const cached = CHORD_CACHE.get(key)
  if (cached) return cached

  const orderedPcs = orderedUniquePitchClassesByBass(midiNotes)
  if (orderedPcs.length === 1) {
    const out = pcName(orderedPcs[0]!)
    CHORD_CACHE.set(key, out)
    return out
  }

  const inputPcSet = new Set(orderedPcs)
  const noteNames = orderedPcs.map(pcName)
  let candidates = Chord.detect(noteNames)
  if (candidates.length === 0 && noteNames.length > 3) {
    // Best-effort fallback: if the full pitch-class set is too dense/noisy to match,
    // try dropping 1-2 non-bass notes and re-detect (cached by (bassPc, mask)).
    const n = noteNames.length
    const maxRemove = Math.min(2, n - 3)
    const seen = new Set<string>()
    for (let remove = 1; remove <= maxRemove && seen.size === 0; remove++) {
      if (remove === 1) {
        for (let i = 1; i < n; i++) {
          const sub = noteNames.filter((_, idx) => idx !== i)
          for (const c of Chord.detect(sub)) seen.add(c)
        }
      } else {
        for (let i = 1; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const sub = noteNames.filter((_, idx) => idx !== i && idx !== j)
            for (const c of Chord.detect(sub)) seen.add(c)
          }
        }
      }
    }
    candidates = [...seen]
  }
  if (candidates.length === 0) {
    CHORD_CACHE.set(key, 'N.C.')
    return 'N.C.'
  }

  const baseNames = [...new Set(candidates.map((c) => c.split('/')[0] ?? c))] as string[]

  let bestName: string | null = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (const name of baseNames) {
    const chord = Chord.get(name)
    if (!chord.tonic) continue

    const chordPcSet = new Set(chord.notes.map((n) => Note.chroma(n)))
    let match = 0
    for (const v of chordPcSet) if (inputPcSet.has(v)) match++
    let extra = 0
    for (const v of inputPcSet) if (!chordPcSet.has(v)) extra++
    const exact = match === chordPcSet.size && extra === 0

    const accidentalCount = (name.match(/[#b]/g) ?? []).length
    const tonicBonus = Note.chroma(chord.tonic) === bassPc ? 60 : 0

    const score =
      (exact ? 10_000 : 0) +
      match * 100 +
      extra * -30 +
      chord.notes.length +
      tonicBonus +
      // Prefer simpler spellings when multiple candidates exist.
      accidentalCount * -50

    if (score > bestScore) {
      bestScore = score
      bestName = name
    }
  }

  if (!bestName) {
    CHORD_CACHE.set(key, 'N.C.')
    return 'N.C.'
  }

  const best = Chord.get(bestName)
  if (!best.tonic) {
    CHORD_CACHE.set(key, bestName)
    return bestName
  }

  const chordPc = Note.chroma(best.tonic)
  if (chordPc !== bassPc) {
    const coreDegrees = new Set([1, 2, 3, 4, 5, 6, 7])
    const corePcs = new Set<number>()
    const len = Math.min(best.notes.length, best.intervals.length)
    for (let i = 0; i < len; i++) {
      const iv = best.intervals[i] ?? ''
      const m = /^(\d+)/.exec(iv)
      const deg = m ? Number.parseInt(m[1]!, 10) : Number.NaN
      if (coreDegrees.has(deg)) corePcs.add(Note.chroma(best.notes[i]!))
    }
    if (corePcs.size === 0) {
      const coreLen = Math.min(4, best.notes.length)
      for (const n of best.notes.slice(0, coreLen)) corePcs.add(Note.chroma(n))
    }
    if (!corePcs.has(bassPc)) {
      const out = `${bestName}/${pcName(bassPc)}`
      CHORD_CACHE.set(key, out)
      return out
    }
  }
  CHORD_CACHE.set(key, bestName)
  return bestName
}

