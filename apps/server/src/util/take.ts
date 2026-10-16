import { RECORDING_OFFSET } from '@mcv/shared'

/**
 * Cleans a recorded take before it is stored:
 * 1. Echo cancellation. When the original line played during the recording, a copy of it can reach the
 *    microphone (speakers, open headphones, or a "listen to this microphone" loopback of another program).
 *    The original line is the echo reference: the delay is found by cross-correlation (GCC-PHAT), the echo
 *    path is estimated as a short FIR filter, and the estimated echo is subtracted.
 * 2. Timing. The countdown is cut, the first word is found relative to the measured noise floor, and the
 *    take is placed so that its first word plays at the same moment as the first word of the original line.
 */

/** Sample rate of the take processing. */
export const TAKE_RATE = 48_000
/** Sample rate of the delay search (TAKE_RATE / 3). */
const ANALYSIS_RATE = 16_000
const FRAME_SECONDS = 0.01
/** Length of the echo path filter (21 ms at 48 kHz). */
const ECHO_TAPS = 1024
/** Samples of the echo path filter before the measured delay. */
const ECHO_MARGIN = 96
/** Smallest delay peak (in standard deviations of the correlation) that counts as an echo. */
const MIN_ECHO_STRENGTH = 8
/** Seconds before the end of the countdown where the search for the first word starts. */
const EARLY_START = 0.6
/** Seconds kept before the first sound of the take and after the last sound. */
const KEEP_BEFORE = 0.05
const KEEP_AFTER = 0.08

// ------------------------------------------------------------------------------------------- FFT

interface FftTables {
  cos: Float64Array
  sin: Float64Array
  reverse: Uint32Array
}

const fftTables = new Map<number, FftTables>()

function tablesFor(size: number): FftTables {
  let tables = fftTables.get(size)
  if (!tables) {
    const cos = new Float64Array(size / 2)
    const sin = new Float64Array(size / 2)
    for (let index = 0; index < size / 2; index += 1) {
      cos[index] = Math.cos((2 * Math.PI * index) / size)
      sin[index] = Math.sin((2 * Math.PI * index) / size)
    }
    const bits = Math.round(Math.log2(size))
    const reverse = new Uint32Array(size)
    for (let index = 1; index < size; index += 1) {
      reverse[index] = (reverse[index >> 1]! >> 1) | ((index & 1) << (bits - 1))
    }
    if (fftTables.size > 6) fftTables.clear()
    tables = { cos, sin, reverse }
    fftTables.set(size, tables)
  }
  return tables
}

/** In-place radix-2 complex FFT. The length must be a power of 2. The inverse is scaled by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const size = re.length
  if (size < 2) return
  const { cos, sin, reverse } = tablesFor(size)
  for (let index = 0; index < size; index += 1) {
    const other = reverse[index]!
    if (other > index) {
      const r = re[index]!
      re[index] = re[other]!
      re[other] = r
      const i = im[index]!
      im[index] = im[other]!
      im[other] = i
    }
  }
  const sign = inverse ? 1 : -1
  for (let length = 2; length <= size; length <<= 1) {
    const half = length >> 1
    const step = size / length
    for (let start = 0; start < size; start += length) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * step]!
        const wi = sign * sin[k * step]!
        const a = start + k
        const b = a + half
        const br = re[b]!
        const bi = im[b]!
        const tr = br * wr - bi * wi
        const ti = br * wi + bi * wr
        const ar = re[a]!
        const ai = im[a]!
        re[b] = ar - tr
        im[b] = ai - ti
        re[a] = ar + tr
        im[a] = ai + ti
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      re[index] = re[index]! / size
      im[index] = im[index]! / size
    }
  }
}

function nextPow2(value: number): number {
  let size = 1
  while (size < value) size <<= 1
  return size
}

// ------------------------------------------------------------------------------------ helpers

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

let decimateKernel: Float64Array | null = null

/** 48 kHz to 16 kHz with a zero-phase low-pass filter, so a lag at 16 kHz times 3 is the lag at 48 kHz. */
function decimate3(input: Float32Array): Float32Array {
  const half = 30
  if (!decimateKernel) {
    const kernel = new Float64Array(2 * half + 1)
    const cutoff = 7000 / 48_000
    let sum = 0
    for (let k = -half; k <= half; k += 1) {
      const sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k)
      const window = 0.42 + 0.5 * Math.cos((Math.PI * k) / half) + 0.08 * Math.cos((2 * Math.PI * k) / half)
      kernel[k + half] = sinc * window
      sum += sinc * window
    }
    for (let index = 0; index < kernel.length; index += 1) kernel[index] = kernel[index]! / sum
    decimateKernel = kernel
  }
  const kernel = decimateKernel
  const output = new Float32Array(Math.floor(input.length / 3))
  for (let m = 0; m < output.length; m += 1) {
    const center = 3 * m
    const from = Math.max(-half, -center)
    const to = Math.min(half, input.length - 1 - center)
    let sum = 0
    for (let k = from; k <= to; k += 1) sum += kernel[k + half]! * input[center + k]!
    output[m] = sum
  }
  return output
}

export interface DelayEstimate {
  /** Samples (with a fraction) that the copy of `reference` in `take` comes after the start of `take`. */
  lag: number
  /** Height of the correlation peak in standard deviations. */
  strength: number
}

/** Finds where `reference` occurs in `take` with the phase-transform cross-correlation (GCC-PHAT). */
export function findDelay(
  take: Float32Array,
  reference: Float32Array,
  minLag: number,
  maxLag: number,
  sampleRate: number,
): DelayEstimate | null {
  const size = nextPow2(take.length + reference.length + 1)
  const ar = new Float64Array(size)
  const ai = new Float64Array(size)
  const br = new Float64Array(size)
  const bi = new Float64Array(size)
  ar.set(take)
  br.set(reference)
  fft(ar, ai)
  fft(br, bi)
  const low = Math.ceil((100 * size) / sampleRate)
  const high = Math.floor((Math.min(7000, sampleRate * 0.45) * size) / sampleRate)
  for (let k = 0; k < size; k += 1) {
    const bin = k <= size / 2 ? k : size - k
    if (bin < low || bin > high) {
      ar[k] = 0
      ai[k] = 0
      continue
    }
    const re = ar[k]! * br[k]! + ai[k]! * bi[k]!
    const im = ai[k]! * br[k]! - ar[k]! * bi[k]!
    const magnitude = Math.hypot(re, im)
    const weight = magnitude > 1e-20 ? 1 / magnitude : 0
    ar[k] = re * weight
    ai[k] = im * weight
  }
  fft(ar, ai, true)
  const first = Math.max(minLag, -(size - 1))
  const last = Math.min(maxLag, size - 1)
  if (last - first < 8) return null
  const at = (lag: number) => ar[(lag + size) % size]!
  let best = first
  let sum = 0
  let squares = 0
  for (let lag = first; lag <= last; lag += 1) {
    const value = at(lag)
    sum += value
    squares += value * value
    if (value > at(best)) best = lag
  }
  const count = last - first + 1
  const mean = sum / count
  const deviation = Math.sqrt(Math.max(1e-30, squares / count - mean * mean))
  const left = at(best - 1)
  const peak = at(best)
  const right = at(best + 1)
  const curve = left - 2 * peak + right
  const fraction = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curve)) : 0
  return { lag: best + fraction, strength: (peak - mean) / deviation }
}

function hann(size: number): Float64Array {
  const window = new Float64Array(size)
  for (let index = 0; index < size; index += 1) window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size)
  return window
}

/**
 * Estimates the FIR filter from `reference` to `take` (Welch cross-spectrum) over the samples `from` to `to`.
 * With `residual` (the take minus a first echo estimate), segments where the player speaks count less, so the
 * voice disturbs the estimate less.
 */
function estimateFilter(
  take: Float32Array,
  reference: Float32Array,
  taps: number,
  from: number,
  to: number,
  residual: Float32Array | null = null,
  use: (center: number) => boolean = () => true,
): Float64Array | null {
  const size = taps * 4
  const hop = taps
  const window = hann(size)
  const starts: number[] = []
  const weights: number[] = []
  for (let start = from; start + size <= to; start += hop) {
    if (!use(start + size / 2)) continue
    let energy = 0
    let disturbance = 0
    for (let index = 0; index < size; index += 1) {
      energy += reference[start + index]! ** 2
      if (residual) disturbance += (residual[start + index]! * window[index]!) ** 2
    }
    if (energy < 1e-7 * size) continue
    starts.push(start)
    weights.push(disturbance / size)
  }
  if (starts.length < 4) return null
  if (residual) {
    const mean = weights.reduce((sum, value) => sum + value, 0) / weights.length
    for (let index = 0; index < weights.length; index += 1) weights[index] = 1 / (weights[index]! + 0.01 * mean + 1e-14)
  } else {
    weights.fill(1)
  }
  const sxyRe = new Float64Array(size)
  const sxyIm = new Float64Array(size)
  const sxx = new Float64Array(size)
  const yr = new Float64Array(size)
  const yi = new Float64Array(size)
  const xr = new Float64Array(size)
  const xi = new Float64Array(size)
  starts.forEach((start, segment) => {
    const weight = weights[segment]!
    for (let index = 0; index < size; index += 1) {
      const w = window[index]!
      yr[index] = take[start + index]! * w
      xr[index] = reference[start + index]! * w
    }
    yi.fill(0)
    xi.fill(0)
    fft(yr, yi)
    fft(xr, xi)
    for (let k = 0; k < size; k += 1) {
      sxyRe[k] = sxyRe[k]! + weight * (yr[k]! * xr[k]! + yi[k]! * xi[k]!)
      sxyIm[k] = sxyIm[k]! + weight * (yi[k]! * xr[k]! - yr[k]! * xi[k]!)
      sxx[k] = sxx[k]! + weight * (xr[k]! ** 2 + xi[k]! ** 2)
    }
  })
  let mean = 0
  for (let k = 0; k < size; k += 1) mean += sxx[k]!
  const regular = (1e-3 * mean) / size + 1e-12
  for (let k = 0; k < size; k += 1) {
    const denominator = sxx[k]! + regular
    yr[k] = sxyRe[k]! / denominator
    yi[k] = sxyIm[k]! / denominator
  }
  fft(yr, yi, true)
  const filter = new Float64Array(taps)
  const taper = Math.floor(taps / 8)
  for (let index = 0; index < taps; index += 1) {
    const fade = index >= taps - taper ? 0.5 + 0.5 * Math.cos((Math.PI * (index - (taps - taper))) / taper) : 1
    filter[index] = yr[index]! * fade
  }
  return filter
}

/** `signal` filtered by `filter` (overlap-add FFT convolution), cut to `length` samples. */
function convolve(signal: Float32Array, filter: Float64Array, length: number): Float32Array {
  const size = nextPow2(filter.length * 4)
  const block = size - filter.length + 1
  const hr = new Float64Array(size)
  const hi = new Float64Array(size)
  hr.set(filter)
  fft(hr, hi)
  const output = new Float32Array(length)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let start = 0; start < Math.min(signal.length, length); start += block) {
    re.fill(0)
    im.fill(0)
    let any = false
    const end = Math.min(signal.length, start + block)
    for (let index = start; index < end; index += 1) {
      const value = signal[index]!
      re[index - start] = value
      if (value !== 0) any = true
    }
    if (!any) continue
    fft(re, im)
    for (let k = 0; k < size; k += 1) {
      const r = re[k]! * hr[k]! - im[k]! * hi[k]!
      im[k] = re[k]! * hi[k]! + im[k]! * hr[k]!
      re[k] = r
    }
    fft(re, im, true)
    const stop = Math.min(length, start + size)
    for (let index = start; index < stop; index += 1) output[index] = output[index]! + re[index - start]!
  }
  return output
}

export interface EchoResult {
  /** Seconds from the start of the take to the copy of the original line. */
  delay: number
  strength: number
  /** How much quieter (dB) the take is after the echo is removed, where the original line played. */
  reduction: number
}

/** Catmull-Rom interpolation of `signal` at a fractional position. */
function sampleAt(signal: Float32Array, position: number): number {
  const index = Math.floor(position)
  const t = position - index
  const p0 = signal[index - 1] ?? 0
  const p1 = signal[index] ?? 0
  const p2 = signal[index + 1] ?? 0
  const p3 = signal[index + 2] ?? 0
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
}

/**
 * Removes the copy of `reference` (the original line) from `take`. `lead` is the expected delay in seconds.
 * Returns null when no clear echo is found; then the take stays as it is.
 */
export function cancelEcho(
  take: Float32Array,
  reference: Float32Array,
  lead: number,
): { samples: Float32Array; echo: EchoResult } | null {
  const ratio = TAKE_RATE / ANALYSIS_RATE
  const take16 = decimate3(take)
  const reference16 = decimate3(reference)
  const delay = findDelay(
    take16,
    reference16,
    Math.round(Math.max(0, lead - 0.5) * ANALYSIS_RATE),
    Math.round((lead + 1.5) * ANALYSIS_RATE),
    ANALYSIS_RATE,
  )
  if (!delay || delay.strength < MIN_ECHO_STRENGTH) return null

  // The playback and the microphone clocks can run at slightly different speeds. Measure the delay
  // in each half of the original line; the change is the drift.
  const half = Math.floor(reference16.length / 2)
  const local = (from: number, to: number) => {
    const part = new Float32Array(reference16.length)
    part.set(reference16.subarray(from, to), from)
    return findDelay(take16, part, Math.floor(delay.lag) - 1600, Math.ceil(delay.lag) + 1600, ANALYSIS_RATE)
  }
  const early = local(0, half)
  const late = local(half, reference16.length)
  let drift = 0
  let base = delay.lag * ratio
  if (early && late && Math.min(early.strength, late.strength) >= MIN_ECHO_STRENGTH / 2) {
    const measured = (late.lag - early.lag) / half
    if (Math.abs(measured) > 2e-6 && Math.abs(measured) < 5e-4 && Math.abs(late.lag - early.lag) < 48) {
      drift = measured
      base = (early.lag - drift * (half / 2)) * ratio
    }
  }
  // The echo of reference sample m is at take sample base + m * (1 + drift). The filter puts it ECHO_MARGIN later.
  const aligned = new Float32Array(take.length)
  const first = Math.max(0, Math.ceil(base - ECHO_MARGIN))
  const stop = Math.min(take.length, Math.floor(base - ECHO_MARGIN + reference.length * (1 + drift)))
  if (drift === 0) {
    const offset = Math.round(base) - ECHO_MARGIN
    for (let index = Math.max(0, offset); index < take.length && index - offset < reference.length; index += 1) {
      aligned[index] = reference[index - offset]!
    }
  } else {
    for (let index = first; index < stop; index += 1) {
      aligned[index] = sampleAt(reference, (index + ECHO_MARGIN - base) / (1 + drift))
    }
  }
  const from = first
  const to = Math.min(take.length, stop + ECHO_TAPS)

  const fit = (residual: Float32Array | null, use?: (center: number) => boolean) =>
    estimateFilter(take, aligned, ECHO_TAPS, from, to, residual, use)
  let filter = fit(null)
  if (!filter) return null
  let estimate = convolve(aligned, filter, take.length)
  const residualOf = (echo: Float32Array) => take.map((value, index) => value - echo[index]!)
  for (let pass = 0; pass < 2; pass += 1) {
    filter = fit(residualOf(estimate)) ?? filter
    estimate = convolve(aligned, filter, take.length)
  }

  // Held-out check: a filter fitted on every other block must make the remaining blocks quieter.
  // A chance peak (for example two clicks) gives a filter that only adds noise, so the take stays as it is.
  const block = Math.max(ECHO_TAPS * 4, Math.min(TAKE_RATE / 2, Math.floor((to - from) / 4)))
  const parity = (position: number) => Math.floor((position - from) / block) % 2
  const residual = residualOf(estimate)
  let gain = 0
  for (const side of [0, 1]) {
    const sideFilter = fit(residual, (center) => parity(center) === side)
    if (!sideFilter) return null
    const sideEstimate = convolve(aligned, sideFilter, take.length)
    for (let index = from; index < to; index += 1) {
      if (parity(index) === side) continue
      const value = take[index]!
      gain += value * value - (value - sideEstimate[index]!) ** 2
    }
  }
  if (gain <= 0) return null

  let before = 0
  let after = 0
  const samples = new Float32Array(take.length)
  for (let index = 0; index < take.length; index += 1) {
    const value = take[index]!
    samples[index] = value - estimate[index]!
    if (index >= from && index < to) {
      before += value * value
      after += samples[index]! ** 2
    }
  }
  return {
    samples,
    echo: {
      delay: Math.round((base + (drift * reference.length) / 2) / TAKE_RATE * 10_000) / 10_000,
      strength: Math.round(delay.strength * 10) / 10,
      reduction: Math.round(100 * Math.log10((before + 1e-12) / (after + 1e-12))) / 10,
    },
  }
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
  /** The original line at TAKE_RATE when it played during the recording (the echo reference), or null. */
  reference: Float32Array | null
  /** Seconds from the start of the original line to its first word. */
  promptOnset: number
  /** Longest result in seconds (the length of the original line). 0 = no limit. */
  maxSeconds: number
}

export interface TakeResult {
  /** Mono samples at TAKE_RATE. Played RECORDING_OFFSET after the line timestamp. */
  samples: Float32Array
  echo: EchoResult | null
  /** Seconds of the first word in the raw take, or null when no speech was found. */
  onset: number | null
}

/** Removes the echo of the original line, cuts the countdown and aligns the first word with the original line. */
export function cleanTake(raw: Float32Array, options: TakeOptions): TakeResult {
  const rate = TAKE_RATE
  let take = highPass(raw, rate)
  let echo: EchoResult | null = null
  if (options.reference && options.reference.length > rate * 0.2) {
    const cancelled = cancelEcho(take, options.reference, options.lead)
    if (cancelled) {
      take = cancelled.samples
      echo = cancelled.echo
    }
  }
  const lead = Math.max(0, options.lead)
  const limit = options.maxSeconds > 0 ? Math.round(options.maxSeconds * rate) : Number.POSITIVE_INFINITY
  const from = Math.max(0, lead - EARLY_START)
  const bounds = speechBounds(take, rate, from)
  if (!bounds) {
    // Nothing stands out from the noise: keep the part after the countdown.
    const start = Math.min(take.length, Math.round(lead * rate))
    return { samples: take.slice(start, Math.min(take.length, start + limit)), echo, onset: null }
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
  return { samples, echo, onset: bounds.onset }
}
