import { MidiTiming } from './src/lib/midi/timing'

const t = new MidiTiming({
  ppq: 480, durationTicks: 480 * 8,
  tempos: [{ ticks: 0, bpm: 120 }],
  timeSignatures: [{ ticks: 0, timeSignature: [4, 4] as [number, number] }],
})

console.log('ticksToSeconds(NaN):', t.ticksToSeconds(NaN))
console.log('ticksToSeconds(Inf):', t.ticksToSeconds(Infinity))
console.log('ticksToSeconds(-Inf):', t.ticksToSeconds(-Infinity))
console.log('secondsToTicks(NaN):', t.secondsToTicks(NaN))
console.log('secondsToTicks(Inf):', t.secondsToTicks(Infinity))
console.log('getBarBeatAtTicks(NaN):', JSON.stringify(t.getBarBeatAtTicks(NaN)))
console.log('durationSeconds:', t.durationSeconds)
console.log('durationTicks:', t.durationTicks)

const t0 = new MidiTiming({
  ppq: 480, durationTicks: 0,
  tempos: [{ ticks: 0, bpm: 120 }],
  timeSignatures: [{ ticks: 0, timeSignature: [4, 4] as [number, number] }],
})
console.log('--- durationTicks=0 ---')
console.log('ticksToSeconds(0):', t0.ticksToSeconds(0))
console.log('secondsToTicks(0):', t0.secondsToTicks(0))
console.log('getBarBeatAtTicks(0):', JSON.stringify(t0.getBarBeatAtTicks(0)))
console.log('getSeekStepTicksAtTicks(0,4):', JSON.stringify(t0.getSeekStepTicksAtTicks(0, 4)))
