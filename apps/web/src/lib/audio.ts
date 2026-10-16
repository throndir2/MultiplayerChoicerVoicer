import { assets } from './assets'

let context: AudioContext | null = null

export function audioContext(): AudioContext {
  if (!context) {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    context = new Ctor({ latencyHint: 'interactive' })
  }
  return context
}

export async function unlockAudio(): Promise<boolean> {
  const ctx = audioContext()
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return false
    }
  }
  return ctx.state === 'running'
}

const decoded = new Map<string, Promise<AudioBuffer>>()

/** Downloads (through the asset manager) and decodes an audio file once. */
export function decodeUrl(url: string, priority = 0): Promise<AudioBuffer> {
  let promise = decoded.get(url)
  if (!promise) {
    promise = assets
      .request(url, priority)
      .then((blob) => blob.arrayBuffer())
      .then((data) => audioContext().decodeAudioData(data))
    promise.catch(() => decoded.delete(url))
    decoded.set(url, promise)
  }
  return promise
}

export async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  return audioContext().decodeAudioData(await blob.arrayBuffer())
}

/** A mono sample buffer that grows while the microphone records. */
export class SampleTrack {
  data: Float32Array
  length = 0

  constructor(
    readonly sampleRate: number,
    capacitySeconds: number,
  ) {
    this.data = new Float32Array(Math.max(1, Math.ceil(sampleRate * capacitySeconds)))
  }

  push(chunk: Float32Array): void {
    if (this.length + chunk.length > this.data.length) {
      const bigger = new Float32Array(Math.max(this.data.length * 2, this.length + chunk.length))
      bigger.set(this.data.subarray(0, this.length))
      this.data = bigger
    }
    this.data.set(chunk, this.length)
    this.length += chunk.length
  }
}

export interface WaveLayer {
  label: string
  samples: Float32Array
  /** Number of valid samples. Defaults to `samples.length`. */
  length?: number
  sampleRate: number
  /** Seconds on the time line where the first sample plays. */
  offset: number
  /** Colour of the peaks. */
  color: string
  /** Colour of the loudness (RMS) core. */
  coreColor: string
}

interface Columns {
  key: string
  min: Float32Array
  max: Float32Array
  rms: Float32Array
  peak: number
}

const columnCache = new WeakMap<Float32Array, Columns>()

/** Minimum, maximum and RMS of the samples under each pixel column. */
function columnsFor(layer: WaveLayer, width: number, scale: number): Columns {
  const length = layer.length ?? layer.samples.length
  const key = `${length}:${width}:${scale}:${layer.offset}:${layer.sampleRate}`
  const cached = columnCache.get(layer.samples)
  if (cached?.key === key) return cached
  const min = new Float32Array(width)
  const max = new Float32Array(width)
  const rms = new Float32Array(width)
  let peak = 0
  const samplesPerColumn = (scale / width) * layer.sampleRate
  const data = layer.samples
  for (let x = 0; x < width; x += 1) {
    const from = Math.floor(((x / width) * scale - layer.offset) * layer.sampleRate)
    const to = Math.max(from + 1, Math.floor(from + samplesPerColumn))
    const start = Math.max(0, from)
    const end = Math.min(length, to)
    if (end <= start) continue
    let low = 1
    let high = -1
    let sum = 0
    for (let index = start; index < end; index += 1) {
      const value = data[index] ?? 0
      if (value < low) low = value
      if (value > high) high = value
      sum += value * value
    }
    min[x] = low
    max[x] = high
    rms[x] = Math.sqrt(sum / (end - start))
    peak = Math.max(peak, high, -low)
  }
  const result = { key, min, max, rms, peak }
  columnCache.set(layer.samples, result)
  return result
}

/**
 * Draws the waveforms on top of each other on one time line, with one column for each device
 * pixel: the peaks (minimum to maximum) and a brighter loudness core.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  layers: WaveLayer[],
  scaleSeconds: number,
  playhead: number | null,
): void {
  const ratio = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const scale = Math.max(scaleSeconds, 0.5)
  const top = 20 * ratio
  const bottom = 14 * ratio
  const middle = top + (height - top - bottom) / 2
  const half = (height - top - bottom) / 2

  // Grid: a line every second, a light line every quarter second.
  ctx.font = `${10 * ratio}px system-ui, sans-serif`
  for (let step = 1; step * 0.25 < scale; step += 1) {
    const seconds = step * 0.25
    const x = Math.round((seconds / scale) * width)
    const whole = step % 4 === 0
    ctx.fillStyle = whole ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)'
    ctx.fillRect(x, top, Math.max(1, Math.round(ratio)), height - top - bottom)
    if (whole) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.fillText(`${seconds} s`, x + 3 * ratio, height - 3 * ratio)
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.12)'
  ctx.fillRect(0, Math.round(middle), width, Math.max(1, Math.round(ratio)))

  let legendX = 8 * ratio
  for (const layer of layers) {
    const columns = columnsFor(layer, width, scale)
    const gain = 0.95 / Math.max(columns.peak, 0.08)
    ctx.fillStyle = layer.color
    for (let x = 0; x < width; x += 1) {
      const high = columns.max[x] ?? 0
      const low = columns.min[x] ?? 0
      if (high === 0 && low === 0) continue
      const y1 = middle - Math.min(1, high * gain) * half
      const y2 = middle - Math.max(-1, low * gain) * half
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1))
    }
    ctx.fillStyle = layer.coreColor
    for (let x = 0; x < width; x += 1) {
      const level = Math.min(1, (columns.rms[x] ?? 0) * gain) * half
      if (level <= 0) continue
      ctx.fillRect(x, middle - level, 1, Math.max(1, level * 2))
    }
    ctx.fillStyle = layer.coreColor
    ctx.fillRect(legendX, 6 * ratio, 10 * ratio, 10 * ratio)
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = `${11 * ratio}px system-ui, sans-serif`
    ctx.fillText(layer.label, legendX + 14 * ratio, 15 * ratio)
    legendX += ctx.measureText(layer.label).width + 30 * ratio
  }

  if (playhead !== null) {
    const x = (playhead / scale) * width
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x, top, 2 * ratio, height - top - bottom)
  }
}

const CAPTURE_PROCESSOR = `
class McvCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(1024)
    this.size = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      if (this.size + channel.length > this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0, this.size))
        this.size = 0
      }
      this.buffer.set(channel, this.size)
      this.size += channel.length
    }
    return true
  }
}
registerProcessor('mcv-capture', McvCapture)
`

let captureModule: Promise<boolean> | null = null

function loadCaptureModule(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return Promise.resolve(false)
  if (!captureModule) {
    const url = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR], { type: 'application/javascript' }))
    captureModule = ctx.audioWorklet.addModule(url).then(
      () => true,
      () => false,
    )
  }
  return captureModule
}

/** Sends every sample of `source` (mixed to mono) to `onSamples`. Returns a function that stops the capture. */
export async function captureSamples(
  ctx: AudioContext,
  source: AudioNode,
  onSamples: (chunk: Float32Array) => void,
): Promise<() => void> {
  const sink = ctx.createGain()
  sink.gain.value = 0
  sink.connect(ctx.destination)
  if (await loadCaptureModule(ctx)) {
    const node = new AudioWorkletNode(ctx, 'mcv-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    })
    node.port.onmessage = (event: MessageEvent<Float32Array>) => onSamples(event.data)
    source.connect(node)
    node.connect(sink)
    return () => {
      node.port.onmessage = null
      node.disconnect()
      sink.disconnect()
    }
  }
  const processor = ctx.createScriptProcessor(1024, 1, 1)
  processor.onaudioprocess = (event) => onSamples(event.inputBuffer.getChannelData(0).slice(0))
  source.connect(processor)
  processor.connect(sink)
  return () => {
    processor.onaudioprocess = null
    processor.disconnect()
    sink.disconnect()
  }
}

export function pickRecorderMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}
