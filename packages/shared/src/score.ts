import type { DubView } from './types.js'

/** Sample rate that the server decodes audio to before it compares a take with the original line. */
export const SCORE_SAMPLE_RATE = 8000
const FRAME_SECONDS = 0.02
/** Loudness range in dB below the loud part of the clip that the envelope keeps. */
const RANGE_DB = 40
/** Envelope value (0..1) that counts as speech when the silence is trimmed. 0.3 = 28 dB below the peak. */
const SPEECH_LEVEL = 0.3
/** Largest time shift in frames that the rhythm check allows (5 x 20 ms = 100 ms). */
const MAX_LAG = 5

/**
 * Loudness envelope of a clip: one value from 0 to 1 for each 20 ms, relative to the loud part of the clip.
 * The silence at both ends is removed. A silent clip gives an empty envelope.
 */
export function loudnessEnvelope(samples: Float32Array, sampleRate = SCORE_SAMPLE_RATE): number[] {
  const size = Math.max(1, Math.round(sampleRate * FRAME_SECONDS))
  const levels: number[] = []
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(samples.length, start + size)
    let sum = 0
    for (let index = start; index < end; index += 1) {
      const value = samples[index] ?? 0
      sum += value * value
    }
    levels.push(10 * Math.log10(sum / Math.max(1, end - start) + 1e-12))
  }
  if (levels.length === 0) return []
  const sorted = [...levels].sort((a, b) => a - b)
  const peak = sorted[Math.floor(0.98 * (sorted.length - 1))] ?? -120
  if (peak < -60) return []
  const raw = levels.map((level) => Math.min(1, Math.max(0, (level - peak + RANGE_DB) / RANGE_DB)))
  const smooth = raw.map((_, index) => {
    const window = raw.slice(Math.max(0, index - 1), index + 2)
    return window.reduce((sum, value) => sum + value, 0) / window.length
  })
  const first = smooth.findIndex((value) => value >= SPEECH_LEVEL)
  if (first < 0) return []
  let last = smooth.length - 1
  while (last > first && (smooth[last] ?? 0) < SPEECH_LEVEL) last -= 1
  return smooth.slice(first, last + 1)
}

function correlation(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (length < 2) return 0
  let meanA = 0
  let meanB = 0
  for (let index = 0; index < length; index += 1) {
    meanA += a[index] ?? 0
    meanB += b[index] ?? 0
  }
  meanA /= length
  meanB /= length
  let cross = 0
  let varA = 0
  let varB = 0
  for (let index = 0; index < length; index += 1) {
    const da = (a[index] ?? 0) - meanA
    const db = (b[index] ?? 0) - meanB
    cross += da * db
    varA += da * da
    varB += db * db
  }
  // A nearly constant envelope (a held tone) has no shape to compare. Two of them match.
  const flatA = varA / length < 4e-4
  const flatB = varB / length < 4e-4
  if (flatA || flatB) return flatA && flatB ? 1 : 0
  return cross / Math.sqrt(varA * varB)
}

function resample(values: number[], length: number): number[] {
  if (values.length === 0 || length <= 0) return []
  if (values.length === 1) return new Array<number>(length).fill(values[0] ?? 0)
  return Array.from({ length }, (_, index) => {
    const position = length === 1 ? 0 : (index * (values.length - 1)) / (length - 1)
    const low = Math.floor(position)
    const high = Math.min(values.length - 1, low + 1)
    const fraction = position - low
    return (values[low] ?? 0) * (1 - fraction) + (values[high] ?? 0) * fraction
  })
}

function padTo(values: number[], length: number, shift: number): number[] {
  const result = new Array<number>(length).fill(0)
  values.forEach((value, index) => {
    const target = index + shift
    if (target >= 0 && target < length) result[target] = value
  })
  return result
}

/** Maps a correlation to 0..1. Unrelated speech is near 0.15; a close copy is above 0.75. */
function grade(value: number): number {
  return Math.min(1, Math.max(0, (value - 0.15) / 0.6))
}

export interface MatchDetails {
  /** 0..100 */
  score: number
  /** The rise and fall of the loudness, with the take stretched to the length of the original. 0..1 */
  shape: number
  /** The same check on the real time line: do the syllables land at the same moments? 0..1 */
  rhythm: number
  /** How close the length of the take is to the length of the original. 0..1 */
  timing: number
}

/** Compares the envelope of a take with the envelope of the original line. */
export function matchEnvelopes(original: number[], take: number[]): MatchDetails {
  if (original.length === 0 || take.length === 0) return { score: 0, shape: 0, rhythm: 0, timing: 0 }
  const ratio = Math.min(original.length, take.length) / Math.max(original.length, take.length)
  const timing = Math.exp(-((Math.log(ratio) / 0.35) ** 2))
  const shape = grade(correlation(original, resample(take, original.length)))
  const length = Math.max(original.length, take.length) + MAX_LAG
  const reference = padTo(original, length, 0)
  let best = -1
  for (let lag = -MAX_LAG; lag <= MAX_LAG; lag += 1) {
    best = Math.max(best, correlation(reference, padTo(take, length, lag)))
  }
  const rhythm = grade(best)
  const score = Math.round(100 * (0.55 * shape + 0.45 * rhythm) * (0.5 + 0.5 * timing))
  return { score, shape, rhythm, timing }
}

/** Score from 0 to 100 for how well a take matches the original line. */
export function matchScore(original: Float32Array, take: Float32Array, sampleRate = SCORE_SAMPLE_RATE): number {
  return matchEnvelopes(loudnessEnvelope(original, sampleRate), loudnessEnvelope(take, sampleRate)).score
}

export function scoreLabel(score: number): string {
  if (score >= 90) return 'Perfect!'
  if (score >= 75) return 'Great'
  if (score >= 55) return 'Good'
  if (score >= 35) return 'OK'
  return 'Try again'
}

export interface PlayerMatch {
  playerId: string
  /** Average score over the lines of the player. A line without a take counts as 0. */
  score: number
  assigned: number
  recorded: number
}

/** The match score of each player in one dub. */
export function dubMatchScores(dub: DubView): PlayerMatch[] {
  const totals = new Map<string, { sum: number; counted: number; assigned: number; recorded: number }>()
  for (const [lineId, playerId] of Object.entries(dub.assignments)) {
    const entry = totals.get(playerId) ?? { sum: 0, counted: 0, assigned: 0, recorded: 0 }
    entry.assigned += 1
    const recording = dub.recordings[lineId]
    if (recording?.playerId === playerId) {
      entry.recorded += 1
      if (typeof recording.score === 'number') {
        entry.sum += recording.score
        entry.counted += 1
      }
    } else {
      entry.counted += 1
    }
    totals.set(playerId, entry)
  }
  return [...totals.entries()]
    .map(([playerId, entry]) => ({
      playerId,
      score: entry.counted > 0 ? Math.round(entry.sum / entry.counted) : 0,
      assigned: entry.assigned,
      recorded: entry.recorded,
    }))
    .sort((a, b) => b.score - a.score)
}

/** Average match score of a whole dub. A line without a take counts as 0. */
export function dubMatchScore(dub: DubView): number {
  let sum = 0
  let counted = 0
  for (const [lineId, playerId] of Object.entries(dub.assignments)) {
    const recording = dub.recordings[lineId]
    if (recording?.playerId === playerId) {
      if (typeof recording.score !== 'number') continue
      sum += recording.score
    }
    counted += 1
  }
  return counted > 0 ? Math.round(sum / counted) : 0
}
