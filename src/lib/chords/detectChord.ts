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

export function detectChordNameFromMidiNotes(activeMidiNotes: number[]): string {
  const midiNotes = activeMidiNotes.filter((n) => Number.isFinite(n)).map((n) => Math.trunc(n))
  if (midiNotes.length === 0) return 'N.C.'

  // Make chord detection stable regardless of input ordering.
  midiNotes.sort((a, b) => a - b)

  const bassMidi = midiNotes[0]!
  const bassPc = pc(bassMidi)

  const orderedPcs = orderedUniquePitchClassesByBass(midiNotes)
  if (orderedPcs.length === 1) return pcName(orderedPcs[0]!)

  const inputPcSet = new Set(orderedPcs)
  const noteNames = orderedPcs.map(pcName)
  const candidates = Chord.detect(noteNames)
  if (candidates.length === 0) return 'N.C.'

  const baseNames = [...new Set(candidates.map((c) => c.split('/')[0] ?? c))] as string[]

  let bestName: string | null = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (const name of baseNames) {
    const chord = Chord.get(name)
    if (!chord.tonic) continue

    const chordPcSet = new Set(chord.notes.map((n) => Note.chroma(n)))
    const exact = setEquals(chordPcSet, inputPcSet)

    const accidentalCount = (name.match(/[#b]/g) ?? []).length
    const tonicBonus = Note.chroma(chord.tonic) === bassPc ? 10 : 0

    const score =
      (exact ? 1000 : 0) +
      chord.notes.length +
      tonicBonus +
      // Prefer simpler spellings when multiple candidates exist.
      accidentalCount * -50

    if (score > bestScore) {
      bestScore = score
      bestName = name
    }
  }

  if (!bestName) return 'N.C.'

  const best = Chord.get(bestName)
  if (!best.tonic) return bestName

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
    if (!corePcs.has(bassPc)) return `${bestName}/${pcName(bassPc)}`
  }
  return bestName
}

