import type { MidiParsed, MidiTrack } from './types'

interface NoteEvent {
  time: number
  midi: number
  on: boolean
}

function buildEvents(tracks: MidiTrack[]): NoteEvent[] {
  const events: NoteEvent[] = []
  for (const track of tracks) {
    for (const n of track.notes) {
      if (
        !Number.isFinite(n.time) ||
        !Number.isFinite(n.endTime) ||
        !Number.isFinite(n.midi) ||
        !Number.isFinite(n.ticks) ||
        !Number.isFinite(n.endTicks)
      ) {
        continue
      }
      // Filter out zero/negative length notes; they create ambiguous on/off ordering.
      if (n.endTime <= n.time || n.endTicks <= n.ticks) continue
      events.push({ time: n.time, midi: n.midi, on: true })
      events.push({ time: n.endTime, midi: n.midi, on: false })
    }
  }

  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time
    // Process note-off before note-on at the same time.
    if (a.on !== b.on) return a.on ? 1 : -1
    return a.midi - b.midi
  })

  return events
}

export class ActiveNoteTracker {
  private readonly events: NoteEvent[]
  private index = 0
  private currentSeconds = 0
  private readonly counts = new Map<number, number>()

  constructor(args: { midi: MidiParsed; trackIndices: number[]; includeDrums?: boolean }) {
    const includeDrums = args.includeDrums ?? false
    const tracks = args.trackIndices
      .map((i) => args.midi.tracks[i])
      .filter((t): t is MidiTrack => Boolean(t))
      .filter((t) => (includeDrums ? true : !t.isDrum))

    this.events = buildEvents(tracks)
  }

  /** Seek and rebuild active notes at the given time. O(N) but seek is infrequent. */
  seek(seconds: number): void {
    const s = Number.isFinite(seconds) ? seconds : 0
    this.counts.clear()
    this.index = 0
    this.currentSeconds = 0
    this.update(s)
  }

  update(seconds: number): void {
    const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
    if (s < this.currentSeconds) {
      this.seek(s)
      return
    }

    while (this.index < this.events.length) {
      const ev = this.events[this.index]!
      if (ev.time > s) break

      if (ev.on) {
        this.counts.set(ev.midi, (this.counts.get(ev.midi) ?? 0) + 1)
      } else {
        const next = (this.counts.get(ev.midi) ?? 0) - 1
        if (next <= 0) this.counts.delete(ev.midi)
        else this.counts.set(ev.midi, next)
      }

      this.index++
    }

    this.currentSeconds = s
  }

  getActiveMidiNotes(): number[] {
    return [...this.counts.keys()].sort((a, b) => a - b)
  }
}

