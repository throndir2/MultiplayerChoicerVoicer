/** Synthetic audio for the take tests: a voice-like signal and noise. */

export const RATE = 48_000

export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A voice-like signal: a glottal pulse train with a moving pitch through two moving formants, in syllables. */
export function voice(seconds: number, seed: number, pauses: [number, number][] = []): Float32Array {
  const next = random(seed)
  const samples = new Float32Array(Math.round(seconds * RATE))
  let phase = 0
  let pitch = 110 + 80 * next()
  let syllableEnd = 0
  let gapEnd = 0
  let f1 = 700
  let f2 = 1400
  const state = [0, 0, 0, 0]
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / RATE
    if (time >= gapEnd && time >= syllableEnd) {
      syllableEnd = time + 0.12 + 0.2 * next()
      gapEnd = syllableEnd + 0.03 + 0.08 * next()
      f1 = 400 + 500 * next()
      f2 = 1000 + 1500 * next()
    }
    pitch = Math.min(260, Math.max(90, pitch + (next() - 0.5) * 2))
    phase += pitch / RATE
    if (phase >= 1) phase -= 1
    const silent = time >= syllableEnd || pauses.some(([from, to]) => time >= from && time < to)
    const position = (time - (syllableEnd - 0.2)) / 0.2
    const envelope = silent ? 0 : Math.sin(Math.PI * Math.min(1, Math.max(0.05, position)))
    const source = envelope * (phase - 0.5 + 0.05 * (next() - 0.5))
    let value = 0
    for (const [slot, frequency] of [
      [0, f1],
      [2, f2],
    ] as const) {
      const r = 0.97
      const c = 2 * r * Math.cos((2 * Math.PI * frequency) / RATE)
      const y = source + c * state[slot]! - r * r * state[slot + 1]!
      state[slot + 1] = state[slot]!
      state[slot] = y
      value += y * (slot === 0 ? 0.05 : 0.03)
    }
    samples[index] = value
  }
  return samples
}

export function noise(length: number, rms: number, seed: number): Float32Array {
  const next = random(seed)
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) samples[index] = (next() * 2 - 1) * rms * Math.sqrt(3)
  return samples
}

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0
  for (let index = from; index < to; index += 1) sum += samples[index]! ** 2
  return Math.sqrt(sum / Math.max(1, to - from))
}

export function scaleTo(samples: Float32Array, target: number): Float32Array {
  const gain = target / rms(samples)
  return samples.map((value) => value * gain)
}

export function addAt(target: Float32Array, source: Float32Array, at: number): void {
  const start = Math.round(at * RATE)
  source.forEach((value, index) => {
    if (start + index < target.length) target[start + index]! += value
  })
}
