import { describe, expect, it } from 'vitest'
import { RECORDING_OFFSET } from '@mcv/shared'
import { TAKE_RATE, cancelEcho, cleanTake, findDelay, speechBounds } from '../src/util/take.js'
import { addAt, addEcho, noise, rms, scaleTo, voice } from './synthetic.js'

const RATE = TAKE_RATE
const LEAD = 1.5
const prompt = new Float32Array(Math.round(2.9 * RATE))
addAt(prompt, scaleTo(voice(2.5, 1), 0.1), 0.15)
const player = scaleTo(voice(2.3, 2, [[1.0, 1.5]]), 0.1)

/** Echo reduction in dB after the start of the original line. */
function erle(take: Float32Array, clean: Float32Array, result: Float32Array): number {
  const from = Math.round(LEAD * RATE)
  const echo = take.map((value, index) => value - clean[index]!)
  const residual = result.map((value, index) => value - clean[index]!)
  return 20 * Math.log10(rms(echo, from) / rms(residual, from))
}

describe('take cleaning', () => {
  it('finds the delay of a copy', () => {
    const take = noise(RATE * 5, 0.003, 3)
    addEcho(take, prompt, 1.62, 0.3)
    const found = findDelay(take, prompt, 0, RATE * 3, RATE)
    expect(found?.strength).toBeGreaterThan(20)
    expect(Math.abs((found?.lag ?? 0) - 1.62 * RATE)).toBeLessThan(2)
  })

  it('removes the echo of the original line while the player speaks', () => {
    const clean = noise(Math.round((LEAD + 2.9) * RATE), 0.002, 4)
    addAt(clean, player, LEAD + 0.35)
    const take = clean.slice()
    // The echo is only 6 dB below the voice.
    addEcho(take, prompt, LEAD + 0.08, 0.5)
    const result = cancelEcho(take, prompt, LEAD)
    expect(result).not.toBeNull()
    expect(Math.abs((result?.echo.delay ?? 0) - (LEAD + 0.08))).toBeLessThan(0.003)
    expect(erle(take, clean, result?.samples ?? take)).toBeGreaterThan(25)
  })

  it('follows a playback clock that runs 80 ppm faster than the microphone clock', () => {
    const clean = noise(Math.round((LEAD + 2.9) * RATE), 0.002, 8)
    addAt(clean, player, LEAD + 0.3)
    const take = clean.slice()
    const start = (LEAD + 0.1) * RATE
    for (let index = 0; index < take.length; index += 1) {
      const position = (index - start) * (1 + 80e-6)
      const whole = Math.floor(position)
      const fraction = position - whole
      if (whole >= 0 && whole + 1 < prompt.length) {
        take[index]! += 0.4 * (prompt[whole]! * (1 - fraction) + prompt[whole + 1]! * fraction)
      }
    }
    const result = cancelEcho(take, prompt, LEAD)
    expect(result).not.toBeNull()
    expect(erle(take, clean, result?.samples ?? take)).toBeGreaterThan(20)
  })

  it('leaves a take without echo alone', () => {
    const take = noise(Math.round((LEAD + 2.9) * RATE), 0.002, 5)
    addAt(take, player, LEAD + 0.3)
    expect(cancelEcho(take, prompt, LEAD)).toBeNull()
  })

  it('cuts the countdown and puts the first word where the original has it, above a loud noise floor', () => {
    // About -38 dBFS of noise: above the old fixed -42 dB silence threshold.
    const take = noise(Math.round((LEAD + 2.9) * RATE), 0.0125, 6)
    addAt(take, player, LEAD + 0.45)
    addEcho(take, prompt, LEAD + 0.1, 0.3)
    const promptOnset = speechBounds(prompt, RATE)?.onset ?? 0
    expect(Math.abs(promptOnset - 0.15)).toBeLessThan(0.03)
    const result = cleanTake(take, { lead: LEAD, reference: prompt, promptOnset, maxSeconds: 2.9 })
    expect(result.echo).not.toBeNull()
    expect(Math.abs((result.onset ?? 0) - (LEAD + 0.45))).toBeLessThan(0.04)
    const bounds = speechBounds(result.samples, RATE)
    expect(Math.abs((bounds?.onset ?? 0) + RECORDING_OFFSET - promptOnset)).toBeLessThan(0.03)
    expect(result.samples.length / RATE).toBeLessThanOrEqual(2.9)
    // Before the first sound the take is silent: no countdown and no noise.
    expect(rms(result.samples, 0, Math.round(0.08 * RATE))).toBeLessThan(1e-6)
  })

  it('keeps a take without speech after the countdown', () => {
    const take = noise(Math.round(4 * RATE), 0.01, 7)
    const result = cleanTake(take, { lead: LEAD, reference: null, promptOnset: 0.15, maxSeconds: 2 })
    expect(result.onset).toBeNull()
    expect(result.samples.length).toBe(2 * RATE)
  })
})
