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

/** Peak amplitude per bin of `binSeconds`. */
export function envelope(buffer: AudioBuffer, binSeconds = 0.02): number[] {
  const data = buffer.getChannelData(0)
  const size = Math.max(1, Math.floor(buffer.sampleRate * binSeconds))
  const result: number[] = []
  for (let start = 0; start < data.length; start += size) {
    let peak = 0
    const end = Math.min(data.length, start + size)
    for (let index = start; index < end; index += 4) {
      const value = Math.abs(data[index] ?? 0)
      if (value > peak) peak = value
    }
    result.push(peak)
  }
  return result
}

export interface WaveRow {
  label: string
  values: number[]
  binSeconds: number
  color: string
}

/** Draws one or more waveform rows on a shared time scale. */
export function drawWaveRows(
  canvas: HTMLCanvasElement,
  rows: WaveRow[],
  scaleSeconds: number,
  playhead: number | null,
): void {
  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const scale = Math.max(scaleSeconds, 0.5)
  const rowHeight = height / Math.max(1, rows.length)

  // One-second grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  for (let second = 1; second < scale; second += 1) {
    const x = Math.round((second / scale) * width) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }

  rows.forEach((row, rowIndex) => {
    const middle = rowHeight * rowIndex + rowHeight / 2
    const barWidth = Math.max(1, (row.binSeconds / scale) * width - 0.5)
    ctx.fillStyle = row.color
    row.values.forEach((value, index) => {
      const x = ((index * row.binSeconds) / scale) * width
      const amplitude = Math.max(1, Math.min(1, value * 1.4) * (rowHeight / 2 - 6))
      ctx.fillRect(x, middle - amplitude, barWidth, amplitude * 2)
    })
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '11px system-ui, sans-serif'
    ctx.fillText(row.label, 6, rowHeight * rowIndex + 14)
    if (rowIndex > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.fillRect(0, rowHeight * rowIndex, width, 1)
    }
  })

  if (playhead !== null) {
    const x = (playhead / scale) * width
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x, 0, 2, height)
  }
}

export function pickRecorderMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}
