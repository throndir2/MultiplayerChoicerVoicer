import { describe, expect, it } from 'vitest'
import { TAKE_RATE, cleanTake, speechBounds } from '../src/util/take.js'
import { addAt, noise, rms, scaleTo, voice } from './synthetic.js'

const RATE = TAKE_RATE
const LEAD = 1.5
const player = scaleTo(voice(2.3, 2, [[1.0, 1.5]]), 0.1)

describe('take cleaning', () => {
  it('cuts the lead and keeps the timing of the player, above a loud noise floor', () => {
    // About -38 dBFS of noise: above the old fixed -42 dB silence threshold.
    const take = noise(Math.round((LEAD + 2.9) * RATE), 0.0125, 6)
    addAt(take, player, LEAD + 0.45)
    const result = cleanTake(take, { lead: LEAD, maxSeconds: 2.9 })
    expect(Math.abs((result.onset ?? 0) - (LEAD + 0.45))).toBeLessThan(0.04)
    // The take is not moved in time: the loudest peak stays exactly LEAD earlier than in the upload.
    const loudest = (samples: Float32Array) => {
      let best = 0
      for (let index = 1; index < samples.length; index += 1) {
        if (Math.abs(samples[index]!) > Math.abs(samples[best]!)) best = index
      }
      return best
    }
    expect(Math.abs(loudest(result.samples) - (loudest(take) - LEAD * RATE))).toBeLessThanOrEqual(2)
    const bounds = speechBounds(result.samples, RATE)
    expect(Math.abs((bounds?.onset ?? 0) - 0.45)).toBeLessThan(0.05)
    expect(result.samples.length / RATE).toBeLessThanOrEqual(2.9)
    // Before the first sound the take is silent: no lead and no noise.
    expect(rms(result.samples, 0, Math.round(0.3 * RATE))).toBeLessThan(1e-6)
  })

  it('keeps a take without speech after the lead', () => {
    const take = noise(Math.round(4 * RATE), 0.01, 7)
    const result = cleanTake(take, { lead: LEAD, maxSeconds: 2 })
    expect(result.onset).toBeNull()
    expect(result.samples.length).toBe(2 * RATE)
  })
})