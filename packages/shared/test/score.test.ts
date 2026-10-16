import { describe, expect, it } from 'vitest'
import { dubMatchScore, dubMatchScores, loudnessEnvelope, matchScore, type DubView } from '../src/index.js'

const RATE = 8000

/** A tone with syllable-like loudness bursts at the given times (seconds), with silence around it. */
function speech(bursts: [number, number][], total: number, lead = 0.2): Float32Array {
  const samples = new Float32Array(Math.round((total + lead) * RATE))
  for (const [start, end] of bursts) {
    for (let index = Math.round((start + lead) * RATE); index < Math.round((end + lead) * RATE); index += 1) {
      const t = index / RATE
      samples[index] = 0.5 * Math.sin(2 * Math.PI * 180 * t)
    }
  }
  return samples
}

const line: [number, number][] = [
  [0, 0.25],
  [0.35, 0.5],
  [0.7, 1.1],
  [1.3, 1.45],
  [1.6, 2.2],
]

describe('loudnessEnvelope', () => {
  it('trims the silence at both ends', () => {
    const envelope = loudnessEnvelope(speech(line, 2.6, 0.5), RATE)
    expect(envelope.length).toBeGreaterThan(105)
    expect(envelope.length).toBeLessThan(118)
  })

  it('gives an empty envelope for silence', () => {
    expect(loudnessEnvelope(new Float32Array(RATE), RATE)).toEqual([])
  })
})

describe('matchScore', () => {
  it('gives 100 for the same take with different silence before it', () => {
    expect(matchScore(speech(line, 2.4, 0.1), speech(line, 2.8, 0.6), RATE)).toBe(100)
  })

  it('gives a lower score for a take that is too fast', () => {
    const fast = line.map(([start, end]) => [start * 0.6, end * 0.6] as [number, number])
    const score = matchScore(speech(line, 2.4), speech(fast, 1.6), RATE)
    expect(score).toBeLessThan(70)
  })

  it('gives a low score for a different rhythm and 0 for silence', () => {
    const other: [number, number][] = [
      [0, 1.0],
      [1.8, 2.2],
    ]
    expect(matchScore(speech(line, 2.4), speech(other, 2.4), RATE)).toBeLessThan(40)
    expect(matchScore(speech(line, 2.4), new Float32Array(RATE * 2), RATE)).toBe(0)
  })
})

describe('dubMatchScores', () => {
  const recording = (playerId: string, score: number | null) => ({
    id: 'r',
    playerId,
    url: '/r.m4a',
    duration: 1,
    createdAt: 0,
    score,
  })
  const dub: DubView = {
    id: 'd',
    name: 'd',
    ownerId: null,
    assignments: { L1: 'a', L2: 'a', L3: 'b', L4: 'b' },
    recordings: { L1: recording('a', 80), L2: recording('a', 60), L3: recording('b', 90) },
    export: { status: 'idle', progress: 0 },
  }

  it('averages the lines of each player and counts a missing take as 0', () => {
    expect(dubMatchScores(dub)).toEqual([
      { playerId: 'a', score: 70, assigned: 2, recorded: 2 },
      { playerId: 'b', score: 45, assigned: 2, recorded: 1 },
    ])
    expect(dubMatchScore(dub)).toBe(58)
  })

  it('skips takes without a score', () => {
    const unscored: DubView = { ...dub, recordings: { ...dub.recordings, L2: recording('a', null) } }
    expect(dubMatchScores(unscored)[0]).toEqual({ playerId: 'a', score: 80, assigned: 2, recorded: 2 })
  })
})
