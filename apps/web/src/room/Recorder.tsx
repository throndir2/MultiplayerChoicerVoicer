import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ClientEvents,
  RECORDING_OFFSET,
  type DubView,
  type PackLine,
  type PackManifest,
  type RecordingView,
} from '@mcv/shared'
import { uploadBinary } from '../lib/api'
import { ScoreBadge } from '../components/ui'
import { assets } from '../lib/assets'
import {
  audioContext,
  decodeBlob,
  decodeUrl,
  drawWaveRows,
  envelope,
  pickRecorderMimeType,
  unlockAudio,
} from '../lib/audio'
import type { Microphone } from '../lib/microphone'
import { useAssetsVersion } from '../lib/preload'
import { useRoom } from '../lib/room'

const BIN = 0.02

interface Envelope {
  values: number[]
  seconds: number
}

interface Props {
  dub: DubView
  line: PackLine
  manifest: PackManifest
  position: number
  total: number
  mic: Microphone
  onPrev: (() => void) | null
  onNext: (() => void) | null
}

export function Recorder({ dub, line, manifest, position, total, mic, onPrev, onNext }: Props) {
  const { room, session, me, emit, notify } = useRoom()
  useAssetsVersion()
  const recording: RecordingView | undefined = dub.recordings[line.id]
  const [mode, setMode] = useState<'idle' | 'recording' | 'saving'>('idle')
  const [playing, setPlaying] = useState<'original' | 'take' | null>(null)
  const [sceneActive, setSceneActive] = useState(false)
  const [useScene, setUseScene] = useState(true)
  const [elapsed, setElapsed] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const promptEnv = useRef<Envelope | null>(null)
  const takeEnv = useRef<Envelope | null>(null)
  const localTake = useRef<AudioBuffer | null>(null)
  const live = useRef<number[]>([])
  const playhead = useRef<number | null>(null)
  const sources = useRef<AudioBufferSourceNode[]>([])
  const frame = useRef<number | null>(null)
  const stopTimer = useRef<number | null>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const recorderRef = useRef<MediaRecorder | null>(null)
  const sourceNode = useRef<MediaStreamAudioSourceNode | null>(null)
  const sampleTimer = useRef<number | null>(null)
  const autoStop = useRef<number | null>(null)
  const cancelled = useRef(false)

  const color = me?.color ?? '#9c6bff'
  const videoUrl = manifest.videoUrl
  const sceneSrc = videoUrl ? (assets.objectUrl(videoUrl) ?? videoUrl) : null
  const imageSrc = assets.objectUrl(line.imageUrl) ?? line.imageUrl

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const isRecording = modeRef.current === 'recording'
    const takeValues = isRecording ? live.current : (takeEnv.current?.values ?? [])
    const takeSeconds = isRecording ? live.current.length * BIN : (takeEnv.current?.seconds ?? 0)
    const scale = Math.max(promptEnv.current?.seconds ?? 0, takeSeconds, 1.5) + 0.3
    drawWaveRows(
      canvas,
      [
        { label: 'Original', values: promptEnv.current?.values ?? [], binSeconds: BIN, color: 'rgba(255,255,255,0.35)' },
        { label: isRecording ? 'Recording…' : 'Your take', values: takeValues, binSeconds: BIN, color },
      ],
      scale,
      playhead.current,
    )
  }, [color])

  const stopPlayback = useCallback(() => {
    for (const source of sources.current) {
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
    }
    sources.current = []
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current)
    stopTimer.current = null
    videoRef.current?.pause()
    playhead.current = null
    setPlaying(null)
    setSceneActive(false)
    draw()
  }, [draw])

  // Load the original line and the saved take for this line.
  useEffect(() => {
    promptEnv.current = null
    localTake.current = null
    live.current = []
    draw()
    let cancelledLoad = false
    if (line.promptUrl) {
      decodeUrl(line.promptUrl, 0)
        .then((buffer) => {
          if (cancelledLoad) return
          promptEnv.current = { values: envelope(buffer, BIN), seconds: buffer.duration }
          draw()
        })
        .catch(() => undefined)
    }
    return () => {
      cancelledLoad = true
      stopPlayback()
    }
  }, [line.id, line.promptUrl, draw, stopPlayback])

  useEffect(() => {
    let cancelledLoad = false
    if (recording) {
      decodeUrl(recording.url, 0)
        .then((buffer) => {
          if (cancelledLoad) return
          takeEnv.current = { values: envelope(buffer, BIN), seconds: buffer.duration }
          localTake.current = null
          draw()
        })
        .catch(() => undefined)
    } else if (!localTake.current) {
      takeEnv.current = null
      draw()
    }
    return () => {
      cancelledLoad = true
    }
  }, [recording, draw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [draw])

  useEffect(() => {
    emit(ClientEvents.progressUpdate, { dubId: dub.id, lineId: line.id, recording: mode === 'recording' })
  }, [dub.id, line.id, mode, emit])

  function animatePlayhead(startAt: number, until: number) {
    const ctx = audioContext()
    const tick = () => {
      const position = ctx.currentTime - startAt
      playhead.current = position >= 0 ? position : null
      draw()
      if (position < until) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }

  async function play(kind: 'original' | 'take') {
    if (modeRef.current !== 'idle') return
    if (playing === kind) {
      stopPlayback()
      return
    }
    stopPlayback()
    await unlockAudio()
    let buffer: AudioBuffer | null = null
    try {
      if (kind === 'original' && line.promptUrl) buffer = await decodeUrl(line.promptUrl, 0)
      if (kind === 'take') buffer = localTake.current ?? (recording ? await decodeUrl(recording.url, 0) : null)
    } catch {
      notify('The audio could not be played')
      return
    }
    if (!buffer) return
    const ctx = audioContext()
    const offset = kind === 'take' ? RECORDING_OFFSET : 0
    const video = videoRef.current
    const timestamp = line.timestamps[0] ?? 0
    setPlaying(kind)

    if (useScene && sceneSrc && video) {
      const preroll = Math.min(1.5, timestamp)
      const from = timestamp - preroll
      setSceneActive(true)
      video.muted = true
      video.currentTime = from
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        video.addEventListener('seeked', done, { once: true })
        window.setTimeout(done, 1500)
      })
      const startAt = ctx.currentTime + 0.05
      void video.play().catch(() => undefined)
      if (manifest.backingUrl && assets.isDone(manifest.backingUrl)) {
        try {
          const backing = await decodeUrl(manifest.backingUrl, 0)
          const source = ctx.createBufferSource()
          source.buffer = backing
          const gain = ctx.createGain()
          gain.gain.value = 0.6
          source.connect(gain).connect(ctx.destination)
          source.start(startAt, from)
          sources.current.push(source)
        } catch {
          // Play the scene without the backing track.
        }
      }
      const voice = ctx.createBufferSource()
      voice.buffer = buffer
      voice.connect(ctx.destination)
      const voiceAt = startAt + preroll + offset
      voice.start(voiceAt)
      sources.current.push(voice)
      animatePlayhead(voiceAt, buffer.duration)
      stopTimer.current = window.setTimeout(stopPlayback, (preroll + offset + buffer.duration + 0.6) * 1000)
      return
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startAt = ctx.currentTime + 0.02
    source.start(startAt)
    sources.current.push(source)
    animatePlayhead(startAt, buffer.duration)
    stopTimer.current = window.setTimeout(stopPlayback, (buffer.duration + 0.15) * 1000)
  }

  function cleanupRecording() {
    if (sampleTimer.current !== null) window.clearInterval(sampleTimer.current)
    if (autoStop.current !== null) window.clearTimeout(autoStop.current)
    sampleTimer.current = null
    autoStop.current = null
    sourceNode.current?.disconnect()
    sourceNode.current = null
  }

  async function startRecording() {
    if (modeRef.current !== 'idle') return
    stopPlayback()
    const stream = await mic.open()
    if (!stream) {
      notify(mic.error || 'The microphone could not start')
      return
    }
    await unlockAudio()
    const ctx = audioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    sourceNode.current = source
    const mimeType = pickRecorderMimeType()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : undefined)
    } catch {
      notify('This browser cannot record audio')
      cleanupRecording()
      return
    }
    const chunks: Blob[] = []
    cancelled.current = false
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = () => {
      cleanupRecording()
      if (cancelled.current) return
      void finish(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }))
    }
    recorderRef.current = recorder
    live.current = []
    takeEnv.current = null
    const samples = new Float32Array(analyser.fftSize)
    const started = performance.now()
    sampleTimer.current = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let peak = 0
      for (const value of samples) peak = Math.max(peak, Math.abs(value))
      live.current.push(peak)
      playhead.current = (performance.now() - started) / 1000
      if (live.current.length % 5 === 0) setElapsed(playhead.current)
      draw()
    }, BIN * 1000)
    const limit = Math.max(6, line.promptDuration * 2.5 + 3)
    autoStop.current = window.setTimeout(() => stopRecording(), limit * 1000)
    recorder.start(250)
    setElapsed(0)
    setMode('recording')
  }

  function stopRecording() {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    recorderRef.current = null
    playhead.current = null
    setMode('saving')
  }

  async function finish(blob: Blob) {
    if (blob.size < 1000) {
      notify('Nothing was recorded. Check your microphone.')
      setMode('idle')
      return
    }
    try {
      const buffer = await decodeBlob(blob)
      localTake.current = buffer
      takeEnv.current = { values: envelope(buffer, BIN), seconds: buffer.duration }
    } catch {
      // The server version is shown when it arrives.
    }
    live.current = []
    draw()
    try {
      const contentType = blob.type || 'audio/webm'
      const result = await uploadBinary<{ recording: RecordingView }>(
        `/api/rooms/${room.code}/recordings?dubId=${encodeURIComponent(dub.id)}&lineId=${encodeURIComponent(line.id)}`,
        blob,
        session.token,
        contentType,
      )
      assets.prefetch(result.recording.url, 1)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The upload failed. Record the line again.')
    } finally {
      setMode('idle')
    }
  }

  // Stop a running recording without saving when the line changes or the view closes.
  useEffect(
    () => () => {
      cancelled.current = true
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      cleanupRecording()
    },
    [line.id],
  )

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'r') {
        event.preventDefault()
        if (modeRef.current === 'idle') void startRecording()
        else if (modeRef.current === 'recording') stopRecording()
      } else if (key === 'p') void play('original')
      else if (key === 't') void play('take')
      else if (key === 'n' && onNext && modeRef.current === 'idle') onNext()
      else if (key === 'b' && onPrev && modeRef.current === 'idle') onPrev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const hasTake = Boolean(recording || localTake.current)
  const characters = line.characters.join(' & ')

  return (
    <section className="card recorder">
      <div className="recorder__head">
        <span className="recorder__count">
          Line {position} of {total}
        </span>
        <span className="recorder__character" style={{ borderColor: color }}>
          {characters}
        </span>
        <span className="muted">Original: {line.promptDuration.toFixed(1)} s</span>
        <span className={`recorder__status${recording ? ' is-saved' : ''}`}>
          {mode === 'saving' ? 'Saving…' : recording ? `✓ Saved (${recording.duration.toFixed(1)} s)` : 'Not recorded yet'}
        </span>
        {recording && mode !== 'saving' && <ScoreBadge score={recording.score} label />}
      </div>

      <div className="stage stage--recorder">
        {imageSrc && <img className={sceneActive ? 'is-hidden' : ''} src={imageSrc} alt="" />}
        {sceneSrc && (
          <video
            ref={videoRef}
            className={sceneActive ? '' : 'is-hidden'}
            src={sceneSrc}
            muted
            playsInline
            preload="metadata"
          />
        )}
        <div className="stage__caption">
          <span className="stage__speaker">{characters}</span>
          {line.text}
        </div>
        {mode === 'recording' && (
          <div className="stage__rec">
            ● REC {elapsed.toFixed(1)} s / {line.promptDuration.toFixed(1)} s
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="wave" aria-label="Waveform of the original line and your take" />

      <div className="recorder__controls">
        <button
          type="button"
          className="button"
          onClick={() => void play('original')}
          disabled={!line.promptUrl || mode !== 'idle'}
        >
          {playing === 'original' ? '■ Stop' : '▶ Original'} <kbd>P</kbd>
        </button>
        {mode === 'recording' ? (
          <button type="button" className="button button--record is-recording" onClick={stopRecording}>
            ■ Stop <kbd>R</kbd>
          </button>
        ) : (
          <button
            type="button"
            className="button button--record"
            onClick={() => void startRecording()}
            disabled={mode !== 'idle'}
          >
            ● {recording ? 'Record again' : 'Record'} <kbd>R</kbd>
          </button>
        )}
        <button type="button" className="button" onClick={() => void play('take')} disabled={!hasTake || mode !== 'idle'}>
          {playing === 'take' ? '■ Stop' : '▶ My take'} <kbd>T</kbd>
        </button>
        {sceneSrc && (
          <label className="toggle toggle--inline">
            <input type="checkbox" checked={useScene} onChange={(event) => setUseScene(event.target.checked)} />
            <span>Play in the scene</span>
          </label>
        )}
      </div>

      <div className="recorder__nav">
        <button type="button" className="button" onClick={() => onPrev?.()} disabled={!onPrev || mode !== 'idle'}>
          ← Previous <kbd>B</kbd>
        </button>
        <button
          type="button"
          className={`button${recording ? ' button--primary' : ''}`}
          onClick={() => onNext?.()}
          disabled={!onNext || mode !== 'idle'}
        >
          Next → <kbd>N</kbd>
        </button>
      </div>
      <p className="hint">
        Start to speak just after you press Record. The server removes the silence at the start and the end, so your
        line plays at the correct time.
      </p>
    </section>
  )
}
