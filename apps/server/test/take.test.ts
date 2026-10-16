import { describe, expect, it } from 'vitest'
import { RECORDING_OFFSET } from '@mcv/shared'
import { TAKE_RATE, cleanTake, speechBounds } from '../src/util/take.js'
import { addAt, noise, rms, scaleTo, voice } from './synthetic.js'

const RATE = TAKE_RATE
const LEAD = 1.5
const prompt = new Float32Array(Math.round(2.9 * RATE))
addAt(prompt, scaleTo(voice(2.5, 1), 0.1), 0.15)
const player = scaleTo(voice(2.3, 2, [[1.0, 1.5]]), 0.1)

describe('take cleaning', () => {
  it('cuts the countdown and puts the first word where the original has it, above a loud noise floor', () => {
    // About -38 dBFS of noise: above the old fixed -42 dB silence threshold.
    const take = noise(Math.round((LEAD + 2.9) * RATE), 0.0125, 6)
    addAt(take, player, LEAD + 0.45)
    const promptOnset = speechBounds(prompt, RATE)?.onset ?? 0
    expect(Math.abs(promptOnset - 0.15)).toBeLessThan(0.03)
    const result = cleanTake(take, { lead: LEAD, promptOnset, maxSeconds: 2.9 })
    expect(Math.abs((result.onset ?? 0) - (LEAD + 0.45))).toBeLessThan(0.04)
    const bounds = speechBounds(result.samples, RATE)
    expect(Math.abs((bounds?.onset ?? 0) + RECORDING_OFFSET - promptOnset)).toBeLessThan(0.03)
    expect(result.samples.length / RATE).toBeLessThanOrEqual(2.9)
    // Before the first sound the take is silent: no countdown and no noise.
    expect(rms(result.samples, 0, Math.round(0.08 * RATE))).toBeLessThan(1e-6)
  })

  it('keeps a take without speech after the countdown', () => {
    const take = noise(Math.round(4 * RATE), 0.01, 7)
    const result = cleanTake(take, { lead: LEAD, promptOnset: 0.15, maxSeconds: 2 })
    expect(result.onset).toBeNull()
    expect(result.samples.length).toBe(2 * RATE)
  })
})