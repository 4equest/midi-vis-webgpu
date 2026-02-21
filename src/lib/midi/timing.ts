import type { TempoEvent, TimeSignature, TimeSignatureEvent } from './types'

export interface BarBeatPosition {
  /** 1-based bar number */
  bar: number
  /** 1-based beat number within bar */
  beat: number
  /** 0..999 progress within beat */
  subBeat1000: number
  timeSignature: TimeSignature
}

interface TempoSegment {
  startTick: number
  endTick: number
  bpm: number
  startSeconds: number
  endSeconds: number
}

interface MeasureInfo {
  startTick: number
  timeSignature: TimeSignature
}

function ticksPerBeat(ppq: number, timeSignature: TimeSignature): number {
  const denom = timeSignature[1]
  // Beat is denominator note length (e.g., 4 => quarter note).
  return (ppq * 4) / denom
}

function ticksToSecondsDelta(ticks: number, bpm: number, ppq: number): number {
  // quarterNotes = ticks / ppq
  // secondsPerQuarter = 60 / bpm
  return (ticks / ppq) * (60 / bpm)
}

function secondsToTicksDelta(seconds: number, bpm: number, ppq: number): number {
  // quarters = seconds / (60/bpm) = seconds * bpm / 60
  return (seconds * bpm * ppq) / 60
}

function normalizeTempoEvents(tempos: TempoEvent[]): TempoEvent[] {
  if (tempos.length === 0) return [{ ticks: 0, bpm: 120 }]

  // Collapse duplicate ticks (last one wins).
  const deduped: TempoEvent[] = []
  for (const t of tempos) {
    const last = deduped[deduped.length - 1]
    if (last && last.ticks === t.ticks) deduped[deduped.length - 1] = t
    else deduped.push(t)
  }

  const first = deduped[0]!
  // MIDI default tempo before the first meta-event is 120 BPM.
  if (first.ticks !== 0) deduped.unshift({ ticks: 0, bpm: 120 })
  return deduped
}

function normalizeTimeSignatureEvents(timeSignatures: TimeSignatureEvent[]): TimeSignatureEvent[] {
  if (timeSignatures.length === 0) return [{ ticks: 0, timeSignature: [4, 4] }]

  // Collapse duplicate ticks (last one wins).
  const deduped: TimeSignatureEvent[] = []
  for (const ts of timeSignatures) {
    const last = deduped[deduped.length - 1]
    if (last && last.ticks === ts.ticks) deduped[deduped.length - 1] = ts
    else deduped.push(ts)
  }

  const first = deduped[0]!
  // MIDI default time signature before the first meta-event is 4/4.
  if (first.ticks !== 0) deduped.unshift({ ticks: 0, timeSignature: [4, 4] })
  return deduped
}

function upperBoundByStartTick(segments: TempoSegment[], tick: number): number {
  // first index where segments[i].startTick > tick
  let lo = 0
  let hi = segments.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid]!.startTick <= tick) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBoundByStartSeconds(segments: TempoSegment[], seconds: number): number {
  // first index where segments[i].startSeconds > seconds
  let lo = 0
  let hi = segments.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid]!.startSeconds <= seconds) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBoundMeasureStart(measures: MeasureInfo[], tick: number): number {
  // first index where measures[i].startTick > tick
  let lo = 0
  let hi = measures.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (measures[mid]!.startTick <= tick) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class MidiTiming {
  readonly ppq: number
  readonly durationTicks: number
  readonly durationSeconds: number

  private readonly tempoSegments: TempoSegment[]
  private readonly measures: MeasureInfo[]

  constructor(args: {
    ppq: number
    durationTicks: number
    tempos: TempoEvent[]
    timeSignatures: TimeSignatureEvent[]
  }) {
    this.ppq = Number.isFinite(args.ppq) && args.ppq > 0 ? args.ppq : 480
    this.durationTicks = Number.isFinite(args.durationTicks) ? Math.max(0, args.durationTicks) : 0

    const tempos = normalizeTempoEvents(
      [...args.tempos]
        .filter((t) => Number.isFinite(t.ticks) && t.ticks >= 0 && Number.isFinite(t.bpm) && t.bpm > 0)
        .map((t) => ({ ticks: Math.floor(t.ticks), bpm: t.bpm }))
        .sort((a, b) => a.ticks - b.ticks),
    )
    this.tempoSegments = this.buildTempoSegments(tempos)
    this.durationSeconds = this.tempoSegments.length
      ? this.tempoSegments[this.tempoSegments.length - 1]!.endSeconds
      : 0

    const timeSignatures = normalizeTimeSignatureEvents(
      [...args.timeSignatures]
        .filter(
          (ts) =>
            Number.isFinite(ts.ticks) &&
            ts.ticks >= 0 &&
            Number.isFinite(ts.timeSignature[0]) &&
            Number.isFinite(ts.timeSignature[1]) &&
            // Validate after flooring to avoid values like 0.5 -> 0.
            Math.floor(ts.timeSignature[0]) > 0 &&
            Math.floor(ts.timeSignature[1]) > 0,
        )
        .map((ts) => ({
          ticks: Math.floor(ts.ticks),
          timeSignature: [Math.floor(ts.timeSignature[0]), Math.floor(ts.timeSignature[1])] as TimeSignature,
        }))
        .sort((a, b) => a.ticks - b.ticks),
    )
    this.measures = this.buildMeasures(timeSignatures)
  }

  private buildTempoSegments(tempos: TempoEvent[]): TempoSegment[] {
    const segments: TempoSegment[] = []
    let secondsCursor = 0
    for (let i = 0; i < tempos.length; i++) {
      const cur = tempos[i]!
      const nextTick = tempos[i + 1]?.ticks ?? this.durationTicks
      const startTick = cur.ticks
      const endTick = Math.max(startTick, Math.min(nextTick, this.durationTicks))
      const bpm = cur.bpm
      const segSeconds = ticksToSecondsDelta(endTick - startTick, bpm, this.ppq)
      const seg: TempoSegment = {
        startTick,
        endTick,
        bpm,
        startSeconds: secondsCursor,
        endSeconds: secondsCursor + segSeconds,
      }
      segments.push(seg)
      secondsCursor = seg.endSeconds
      if (endTick >= this.durationTicks) break
    }
    return segments
  }

  private buildMeasures(timeSignatures: TimeSignatureEvent[]): MeasureInfo[] {
    const measures: MeasureInfo[] = []

    let tsIndex = 0
    let currentTS = timeSignatures[0]!.timeSignature
    let nextTSTick = timeSignatures[1]?.ticks ?? Number.POSITIVE_INFINITY

    let tickCursor = 0
    while (tickCursor <= this.durationTicks) {
      measures.push({ startTick: tickCursor, timeSignature: currentTS })

      const tpb = ticksPerBeat(this.ppq, currentTS)
      const measureLen = tpb * currentTS[0]
      const nextMeasureTick = tickCursor + measureLen

      if (nextMeasureTick > nextTSTick) {
        // Time signature changes mid-measure; treat as forced boundary at change tick.
        tickCursor = nextTSTick
      } else {
        tickCursor = nextMeasureTick
      }

      if (tickCursor >= nextTSTick) {
        tsIndex++
        currentTS = timeSignatures[tsIndex]?.timeSignature ?? currentTS
        nextTSTick = timeSignatures[tsIndex + 1]?.ticks ?? Number.POSITIVE_INFINITY
      }

      if (!Number.isFinite(tickCursor) || tickCursor <= measures[measures.length - 1]!.startTick) break
    }

    return measures
  }

  ticksToSeconds(ticks: number): number {
    const input = Number.isFinite(ticks) ? ticks : ticks === Number.POSITIVE_INFINITY ? this.durationTicks : 0
    const t = Math.max(0, Math.min(this.durationTicks, input))
    const ub = upperBoundByStartTick(this.tempoSegments, t)
    const seg = this.tempoSegments[Math.max(0, ub - 1)]!
    return seg.startSeconds + ticksToSecondsDelta(t - seg.startTick, seg.bpm, this.ppq)
  }

  secondsToTicks(seconds: number): number {
    const input = Number.isFinite(seconds) ? seconds : seconds === Number.POSITIVE_INFINITY ? this.durationSeconds : 0
    const s = Math.max(0, Math.min(this.durationSeconds, input))
    const ub = upperBoundByStartSeconds(this.tempoSegments, s)
    const seg = this.tempoSegments[Math.max(0, ub - 1)]!
    const tickFloat = seg.startTick + secondsToTicksDelta(s - seg.startSeconds, seg.bpm, this.ppq)
    // Floor for stable display and to avoid overshooting segment end.
    const tickInt = Math.floor(tickFloat + 1e-6)
    return Math.max(0, Math.min(this.durationTicks, tickInt))
  }

  getBarBeatAtTicks(ticks: number): BarBeatPosition {
    const input = Number.isFinite(ticks) ? ticks : ticks === Number.POSITIVE_INFINITY ? this.durationTicks : 0
    const tClamped = Math.max(0, Math.min(this.durationTicks, input))
    // Treat durationTicks as end-exclusive to avoid reporting the next bar at the exact end.
    const t = this.durationTicks > 0 && tClamped === this.durationTicks ? this.durationTicks - 1 : tClamped
    const ub = upperBoundMeasureStart(this.measures, t)
    const measureIndex = Math.max(0, ub - 1)
    const measure = this.measures[measureIndex]!

    const ts = measure.timeSignature
    const tpb = ticksPerBeat(this.ppq, ts)
    const ticksIntoMeasure = t - measure.startTick

    const beatIndex0 = Math.min(ts[0] - 1, Math.max(0, Math.floor(ticksIntoMeasure / tpb)))
    const beat = beatIndex0 + 1

    const ticksIntoBeat = ticksIntoMeasure - beatIndex0 * tpb
    const beatProgress = tpb > 0 ? Math.max(0, Math.min(0.999999, ticksIntoBeat / tpb)) : 0
    const subBeat1000 = Math.min(999, Math.max(0, Math.floor(beatProgress * 1000)))

    return { bar: measureIndex + 1, beat, subBeat1000, timeSignature: ts }
  }

  getBarStartTick(bar: number): number {
    const b = Number.isFinite(bar) ? Math.floor(bar) : 1
    const idx = b - 1
    if (idx <= 0) return 0
    if (idx >= this.measures.length) return this.durationTicks
    return this.measures[idx]!.startTick
  }

  getPageIndexForBar(bar: number, pageBars: number): number {
    const b = Number.isFinite(bar) ? Math.max(1, Math.floor(bar)) : 1
    const bars = Number.isFinite(pageBars) ? Math.max(1, Math.floor(pageBars)) : 1
    return Math.floor((b - 1) / bars)
  }

  getPageRangeForBar(bar: number, pageBars: number): { pageIndex: number; startBar: number; endBar: number } {
    const b = Number.isFinite(bar) ? Math.max(1, Math.floor(bar)) : 1
    const bars = Number.isFinite(pageBars) ? Math.max(1, Math.floor(pageBars)) : 1
    const pageIndex = this.getPageIndexForBar(b, bars)
    const startBar = pageIndex * bars + 1
    const endBar = startBar + bars - 1
    return { pageIndex, startBar, endBar }
  }

  getPageTickRange(pageIndex: number, pageBars: number): { startTick: number; endTick: number } {
    const pi = Number.isFinite(pageIndex) ? Math.max(0, Math.floor(pageIndex)) : 0
    const bars = Number.isFinite(pageBars) ? Math.max(1, Math.floor(pageBars)) : 1
    const startBar = pi * bars + 1
    const endBarExclusive = startBar + bars
    const startTick = this.getBarStartTick(startBar)
    const endTick = this.getBarStartTick(endBarExclusive)
    return { startTick, endTick }
  }

  /** Key seek step sizes in ticks for the configured time signature at a given playhead tick. */
  getSeekStepTicksAtTicks(ticks: number, pageBars: number): { beat: number; bar: number; page: number } {
    const pos = this.getBarBeatAtTicks(ticks)
    const tpb = ticksPerBeat(this.ppq, pos.timeSignature)
    const beat = Math.max(1, Math.round(tpb))

    const barStartTick = this.getBarStartTick(pos.bar)
    const nextBarStartTick = this.getBarStartTick(pos.bar + 1)
    const bar = Math.max(1, nextBarStartTick - barStartTick)

    const pageIndex = this.getPageIndexForBar(pos.bar, pageBars)
    const pageRange = this.getPageTickRange(pageIndex, pageBars)
    const page = Math.max(1, pageRange.endTick - pageRange.startTick)
    return { beat, bar, page }
  }
}

