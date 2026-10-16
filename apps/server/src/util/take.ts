import { RECORDING_OFFSET } from '@mcv/shared'

/**
 * Cleans a recorded take before it is stored: the countdown is cut, the first word is found relative to the
 * measured noise floor, and the take is placed so that its first word plays at the same moment as the first
 * word of the original line.
 */

/** Sample rate of the take processing. */
export const TAKE_RATE = 48_000
const FRAME_SECONDS = 0.01
/** Seconds before the end of the countdown where the search for the first word starts. */
const EARLY_START = 0.6
/** Seconds kept before the first sound of the take and after the last sound. */
const KEEP_BEFORE = 0.05
const KEEP_AFTER = 0.08

/** Removes DC and rumble (one-pole high-pass at about 50 Hz). */
function highPass(samples: Float32Array, sampleRate: number): Float32Array {
  const output = new Float32Array(samples.length)
  const rc = 1 / (2 * Math.PI * 50)
  const alpha = rc / (rc + 1 / sampleRate)
  let previousIn = 0
  let previousOut = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]!
    previousOut = alpha * (previousOut + value - previousIn)
    previousIn = value
    output[index] = previousOut
  }
  return output
}

// ----------------------------------------------------------------------------------- speech

export interface SpeechBounds {
  /** Seconds of the first word: where the level stays clearly above the noise. */
  onset: number
  /** Seconds where the first sound starts (soft attacks before the onset included). */
  start: number
  /** Seconds where the last sound ends. */
  end: number
  /** Noise floor and loud level in dB. */
  noise: number
  peak: number
}

/** Finds the speech in a clip relative to its own noise floor. Null when nothing stands out from the noise. */
export function speechBounds(samples: Float32Array, sampleRate: number, from = 0): SpeechBounds | null {
  const size = Math.max(1, Math.round(sampleRate * FRAME_SECONDS))
  const count = Math.floor(samples.length / size)
  if (count < 3) return null
  const levels = new Float64Array(count)
  for (let frame = 0; frame < count; frame += 1) {
    let sum = 0
    for (let index = frame * size; index < (frame + 1) * size; index += 1) sum += samples[index]! ** 2
    levels[frame] = Math.max(-120, 10 * Math.log10(sum / size + 1e-14))
  }
  const firstFrame = Math.min(count - 1, Math.max(0, Math.floor((from * sampleRate) / size)))
  const percentile = (values: Float64Array, fraction: number) => {
    const sorted = Float64Array.from(values).sort()
    return sorted[Math.floor(fraction * (sorted.length - 1))] ?? -120
  }
  const noise = percentile(levels, 0.1)
  const peak = percentile(levels.subarray(firstFrame), 0.98)
  if (peak - noise < 12 || peak < -70) return null
  const threshold = Math.max(noise + 12, peak - 30)
  const soft = Math.max(noise + 6, peak - 40)
  let onset = -1
  for (let frame = firstFrame; frame < count && onset < 0; frame += 1) {
    if (levels[frame]! <= threshold) continue
    let above = 0
    for (let next = frame; next < Math.min(count, frame + 6); next += 1) if (levels[next]! > threshold) above += 1
    if (above >= 4) onset = frame
  }
  if (onset < 0) return null
  let start = onset
  while (start > firstFrame && onset - start < 15 && levels[start - 1]! > soft) start -= 1
  let last = count - 1
  while (last > onset && levels[last]! <= threshold) last -= 1
  let end = last
  while (end + 1 < count && end - last < 30 && levels[end + 1]! > soft) end += 1
  const seconds = (frame: number) => (frame * size) / sampleRate
  return { onset: seconds(onset), start: seconds(start), end: seconds(end + 1), noise, peak }
}

// -------------------------------------------------------------------------------------- take

export interface TakeOptions {
  /** Seconds from the start of the take to the start of the original line (the end of the countdown). */
  lead: number
  /** Seconds from the start of the original line to its first word. */
  promptOnset: number
  /** Longest result in seconds (the length of the original line). 0 = no limit. */
  maxSeconds: number
}

export interface TakeResult {
  /** Mono samples at TAKE_RATE. Played RECORDING_OFFSET after the line timestamp. */
  samples: Float32Array
  /** Seconds of the first word in the raw take, or null when no speech was found. */
  onset: number | null
}

/** Cuts the countdown and aligns the first word with the original line. */
export function cleanTake(raw: Float32Array, options: TakeOptions): TakeResult {
  const rate = TAKE_RATE
  const take = highPass(raw, rate)
  const lead = Math.max(0, options.lead)
  const limit = options.maxSeconds > 0 ? Math.round(options.maxSeconds * rate) : Number.POSITIVE_INFINITY
  const from = Math.max(0, lead - EARLY_START)
  const bounds = speechBounds(take, rate, from)
  if (!bounds) {
    // Nothing stands out from the noise: keep the part after the countdown.
    const start = Math.min(take.length, Math.round(lead * rate))
    return { samples: take.slice(start, Math.min(take.length, start + limit)), onset: null }
  }
  const keepStart = Math.max(from, bounds.start - KEEP_BEFORE)
  const keepEnd = Math.min(take.length / rate, bounds.end + KEEP_AFTER)
  // The first word plays where the first word of the original line plays.
  const target = Math.max(options.promptOnset - RECORDING_OFFSET, bounds.onset - keepStart)
  const shift = Math.round((bounds.onset - target) * rate)
  const first = Math.round(keepStart * rate)
  const last = Math.round(keepEnd * rate)
  const length = Math.max(0, Math.min(last - shift, limit))
  const samples = new Float32Array(length)
  const fadeIn = Math.round(0.02 * rate)
  const fadeOut = Math.round(0.05 * rate)
  const end = Math.min(last, length + shift)
  for (let index = Math.max(0, first, shift); index < end; index += 1) {
    let gain = 1
    if (index - first < fadeIn) gain *= (index - first) / fadeIn
    if (end - index < fadeOut) gain *= (end - index) / fadeOut
    samples[index - shift] = take[index]! * gain
  }
  return { samples, onset: bounds.onset }
}
