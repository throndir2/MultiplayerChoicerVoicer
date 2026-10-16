import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
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
  SampleTrack,
  audioContext,
  captureSamples,
  decodeBlob,
  decodeUrl,
  drawWaveform,
  pickRecorderMimeType,
  unlockAudio,
  type WaveLayer,
} from '../lib/audio'
import type { Microphone } from '../lib/microphone'
import { useAssetsVersion } from '../lib/preload'
import { useRoom } from '../lib/room'

/** Seconds between "Record" and the start of the line. The original line (if it is on) starts after this. */
const LEAD_IN = 1.5
/** Recording length for a line without original audio. */
const FALLBACK_SECONDS = 6

interface Wave {
  samples: Float32Array
  sampleRate: number
  duration: number
  /** Seconds on the time line where the first sample plays. */
  offset: number
}

function waveOf(buffer: AudioBuffer, offset: number): Wave {
  return { samples: buffer.getChannelData(0), sampleRate: buffer.sampleRate, duration: buffer.duration, offset }
}

function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  return `${color}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`
}

interface Props {
  dub: DubView
  line: PackLine
  manifest: PackManifest
  position: number
  total: number
  mic: Microphone
  /** Volume (0 to 1) of the original line while the player records. 0 does not play it. */
  guideVolume: number
  /** Show the line picture and play the scene. Off shows a default picture, so the scene stays a surprise. */
  showScene: boolean
  /** "Next" needs a take of this line (when the player cannot come back). */
  requireTake: boolean
  /** Play the original line once when the recorder opens (the player moved to this line). */
  autoPlay: boolean
  onPrev: (() => void) | null
  onNext: (() => void) | null
  /** Shown instead of "Next" on the last line. */
  onFinish: (() => void) | null
  canFinish: boolean
}

export function Recorder({
  dub,
  line,
  manifest,
  position,
  total,
  mic,
  guideVolume,
  showScene,
  requireTake,
  autoPlay,
  onPrev,
  onNext,
  onFinish,
  canFinish,
}: Props) {
  const { room, session, me, emit, notify } = useRoom()
  useAssetsVersion()
  const recording: RecordingView | undefined = dub.recordings[line.id]
  const [mode, setMode] = useState<'idle' | 'recording' | 'saving'>('idle')
  const [playing, setPlaying] = useState<'original' | 'take' | null>(null)
  const [sceneActive, setSceneActive] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const prompt = useRef<Wave | null>(null)
  const take = useRef<Wave | null>(null)
  const localTake = useRef<AudioBuffer | null>(null)
  const live = useRef<SampleTrack | null>(null)
  const playhead = useRef<number | null>(null)
  const sources = useRef<AudioBufferSourceNode[]>([])
  const frame = useRef<number | null>(null)
  const stopTimer = useRef<number | null>(null)
  const sceneTimer = useRef<number | null>(null)
  /** Changes on each stop, so a playback that is still loading does not start after a stop. */
  const playToken = useRef(0)
  const starting = useRef(false)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const recorderRef = useRef<MediaRecorder | null>(null)
  const sourceNode = useRef<MediaStreamAudioSourceNode | null>(null)
  const stopCapture = useRef<(() => void) | null>(null)
  const autoStop = useRef<number | null>(null)
  const cancelled = useRef(false)

  const color = me?.color ?? '#9c6bff'
  const lineSeconds = line.promptDuration > 0 ? line.promptDuration : FALLBACK_SECONDS
  const videoUrl = manifest.videoUrl
  const sceneSrc = showScene && videoUrl ? (assets.objectUrl(videoUrl) ?? videoUrl) : null
  const imageSrc = showScene ? (assets.objectUrl(line.imageUrl) ?? line.imageUrl) : null

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const track = modeRef.current !== 'idle' ? live.current : null
    // While the microphone records, the original line is shown where it plays (after the lead-in).
    const lead = track ? LEAD_IN : 0
    const layers: WaveLayer[] = []
    let end = 1
    const original = prompt.current
    if (original) {
      layers.push({
        label: 'Original',
        samples: original.samples,
        sampleRate: original.sampleRate,
        offset: lead,
        color: 'rgba(255,255,255,0.22)',
        coreColor: 'rgba(255,255,255,0.5)',
      })
      end = Math.max(end, lead + original.duration)
    }
    if (track) {
      layers.push({
        label: 'Recording…',
        samples: track.data,
        length: track.length,
        sampleRate: track.sampleRate,
        offset: 0,
        color: withAlpha(color, 0.5),
        coreColor: withAlpha(color, 0.9),
      })
      end = Math.max(end, LEAD_IN + lineSeconds)
    } else if (take.current) {
      layers.push({
        label: 'Your take',
        samples: take.current.samples,
        sampleRate: take.current.sampleRate,
        offset: take.current.offset,
        color: withAlpha(color, 0.5),
        coreColor: withAlpha(color, 0.9),
      })
      end = Math.max(end, take.current.offset + take.current.duration)
    }
    drawWaveform(canvas, layers, end + 0.2, playhead.current)
  }, [color, lineSeconds])

  const stopPlayback = useCallback(() => {
    playToken.current += 1
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
    if (sceneTimer.current !== null) window.clearTimeout(sceneTimer.current)
    sceneTimer.current = null
    videoRef.current?.pause()
    playhead.current = null
    setPlaying(null)
    setSceneActive(false)
    draw()
  }, [draw])

  // Load the original line for this line.
  useEffect(() => {
    prompt.current = null
    localTake.current = null
    live.current = null
    draw()
    let cancelledLoad = false
    if (line.promptUrl) {
      decodeUrl(line.promptUrl, 0)
        .then((buffer) => {
          if (cancelledLoad) return
          prompt.current = waveOf(buffer, 0)
          draw()
        })
        .catch(() => undefined)
    }
    return () => {
      cancelledLoad = true
      stopPlayback()
    }
  }, [line.id, line.promptUrl, draw, stopPlayback])

  // Load the saved take. It plays RECORDING_OFFSET after the line timestamp, so it is drawn there.
  useEffect(() => {
    let cancelledLoad = false
    if (recording) {
      decodeUrl(recording.url, 0)
        .then((buffer) => {
          if (cancelledLoad) return
          take.current = waveOf(buffer, RECORDING_OFFSET)
          localTake.current = null
          draw()
        })
        .catch(() => undefined)
    } else if (!localTake.current) {
      take.current = null
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

  /** Moves the playhead. `zeroAt` is the audio clock time of 0 s on the waveform. */
  function animatePlayhead(zeroAt: number, until: number) {
    const ctx = audioContext()
    const tick = () => {
      const position = ctx.currentTime - zeroAt
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
    const token = playToken.current
    // A stop, a recording, a new playback or a line change while the audio loads cancels this playback.
    const stale = () => token !== playToken.current || modeRef.current !== 'idle'
    await unlockAudio()
    let buffer: AudioBuffer | null = null
    try {
      if (kind === 'original' && line.promptUrl) buffer = await decodeUrl(line.promptUrl, 0)
      if (kind === 'take') buffer = localTake.current ?? (recording ? await decodeUrl(recording.url, 0) : null)
    } catch {
      if (!stale()) notify('The audio could not be played')
      return
    }
    if (!buffer || stale()) return
    const ctx = audioContext()
    const offset = kind === 'take' ? RECORDING_OFFSET : 0
    const waveOffset = kind === 'take' ? (take.current?.offset ?? RECORDING_OFFSET) : 0
    const until = waveOffset + buffer.duration
    const video = videoRef.current
    const timestamp = line.timestamps[0] ?? 0
    setPlaying(kind)

    if (sceneSrc && video) {
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
      if (stale()) return
      const startAt = ctx.currentTime + 0.05
      void video.play().catch(() => undefined)
      if (manifest.backingUrl && assets.isDone(manifest.backingUrl)) {
        try {
          const backing = await decodeUrl(manifest.backingUrl, 0)
          if (stale()) return
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
      animatePlayhead(voiceAt - waveOffset, until)
      stopTimer.current = window.setTimeout(stopPlayback, (preroll + offset + buffer.duration + 0.6) * 1000)
      return
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startAt = ctx.currentTime + 0.02
    source.start(startAt)
    sources.current.push(source)
    animatePlayhead(startAt - waveOffset, until)
    stopTimer.current = window.setTimeout(stopPlayback, (buffer.duration + 0.15) * 1000)
  }

  function cleanupRecording() {
    if (autoStop.current !== null) window.clearTimeout(autoStop.current)
    autoStop.current = null
    stopCapture.current?.()
    stopCapture.current = null
    sourceNode.current?.disconnect()
    sourceNode.current = null
  }

  async function startRecording() {
    if (modeRef.current !== 'idle' || starting.current) return
    starting.current = true
    try {
      await beginRecording()
    } finally {
      starting.current = false
    }
  }

  async function beginRecording() {
    stopPlayback()
    const stream = await mic.open()
    if (!stream) {
      notify(mic.error || 'The microphone could not start')
      return
    }
    await unlockAudio()
    const ctx = audioContext()

    // The original line can play quietly during the recording, so the player can speak with it.
    let guide: AudioBuffer | null = null
    if (guideVolume > 0 && line.promptUrl) {
      try {
        guide = await decodeUrl(line.promptUrl, 0)
      } catch {
        // Record without the original line.
      }
    }
    const video = videoRef.current
    const timestamp = line.timestamps[0] ?? 0
    const preroll = Math.min(LEAD_IN, timestamp)
    const withScene = Boolean(sceneSrc && video)
    if (withScene && video) {
      video.muted = true
      video.currentTime = timestamp - preroll
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        video.addEventListener('seeked', done, { once: true })
        window.setTimeout(done, 1500)
      })
    }

    const source = ctx.createMediaStreamSource(stream)
    sourceNode.current = source
    const limit = LEAD_IN + lineSeconds
    const track = new SampleTrack(ctx.sampleRate, limit + 1)
    try {
      stopCapture.current = await captureSamples(ctx, source, (chunk) => track.push(chunk))
    } catch {
      stopCapture.current = null
    }
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
    live.current = track
    recorder.start(250)
    const startedAt = ctx.currentTime
    // The recording never runs longer than the original line.
    autoStop.current = window.setTimeout(() => stopRecording(), limit * 1000)
    if (guide) {
      const voice = ctx.createBufferSource()
      voice.buffer = guide
      const gain = ctx.createGain()
      gain.gain.value = guideVolume
      voice.connect(gain).connect(ctx.destination)
      voice.start(startedAt + LEAD_IN)
      sources.current.push(voice)
    }
    if (withScene && video) {
      setSceneActive(true)
      sceneTimer.current = window.setTimeout(() => void video.play().catch(() => undefined), (LEAD_IN - preroll) * 1000)
    }
    modeRef.current = 'recording'
    setElapsed(0)
    setMode('recording')
    let shown = -1
    const tick = () => {
      if (modeRef.current !== 'recording') return
      const position = Math.min(limit, ctx.currentTime - startedAt)
      playhead.current = position
      const tenths = Math.floor(position * 10)
      if (tenths !== shown) {
        shown = tenths
        setElapsed(position)
      }
      draw()
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }

  function stopRecording() {
    if (modeRef.current !== 'recording') return
    if (autoStop.current !== null) window.clearTimeout(autoStop.current)
    autoStop.current = null
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    recorderRef.current = null
    modeRef.current = 'saving'
    setMode('saving')
    stopPlayback()
  }

  async function finish(blob: Blob) {
    if (blob.size < 1000) {
      notify('Nothing was recorded. Check your microphone.')
      live.current = null
      setMode('idle')
      draw()
      return
    }
    try {
      const buffer = await decodeBlob(blob)
      localTake.current = buffer
      // The original line started LEAD_IN after the start of the recording.
      take.current = waveOf(buffer, -LEAD_IN)
    } catch {
      // The server version is shown when it arrives.
    }
    live.current = null
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

  // The recorder opens again for each line, so this plays the original line once when the player moves to a line.
  useEffect(() => {
    if (!autoPlay || !line.promptUrl) return
    const timer = window.setTimeout(() => void play('original'), 0)
    return () => window.clearTimeout(timer)
  }, [])

  const hasTake = Boolean(recording || localTake.current)
  const nextReady = Boolean(onNext) && (!requireTake || Boolean(recording))

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
      else if (key === 'n' && modeRef.current === 'idle') {
        if (nextReady) onNext?.()
        else if (onFinish && canFinish) onFinish()
      } else if (key === 'b' && onPrev && modeRef.current === 'idle') onPrev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const characters = line.characters.join(' & ')
  const recordingSeconds = Math.max(0, elapsed - LEAD_IN)

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
        {showScene ? (
          <>
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
          </>
        ) : (
          <div className="stage__placeholder" style={{ '--player': color } as CSSProperties}>
            <img src="/favicon.svg" alt="" />
            <span>The scene is a surprise. You see it when you watch the dubs.</span>
          </div>
        )}
        <div className="stage__caption">
          <span className="stage__speaker">{characters}</span>
          {line.text}
        </div>
        {mode === 'recording' && (
          <div className="stage__rec">
            ●{' '}
            {elapsed < LEAD_IN
              ? `Get ready… ${(LEAD_IN - elapsed).toFixed(1)} s`
              : `REC ${Math.min(recordingSeconds, lineSeconds).toFixed(1)} s / ${lineSeconds.toFixed(1)} s`}
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="wave" aria-label="Waveform of your take on top of the original line" />

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
      </div>

      <div className="recorder__nav">
        {onPrev ? (
          <button type="button" className="button" onClick={() => onPrev()} disabled={mode !== 'idle'}>
            ← Previous <kbd>B</kbd>
          </button>
        ) : (
          <span />
        )}
        {onFinish && !onNext ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => onFinish()}
            disabled={!canFinish || mode !== 'idle'}
            title={canFinish ? undefined : 'Record every line first'}
          >
            ✓ Finish <kbd>N</kbd>
          </button>
        ) : (
          <button
            type="button"
            className={`button${recording ? ' button--primary' : ''}`}
            onClick={() => onNext?.()}
            disabled={!nextReady || mode !== 'idle'}
            title={onNext && !nextReady ? 'Record this line first' : undefined}
          >
            Next → <kbd>N</kbd>
          </button>
        )}
      </div>
      <p className="hint">
        After you press Record, a {LEAD_IN} s countdown runs.{' '}
        {guideVolume > 0 && line.promptUrl
          ? 'Then the original line plays quietly. Speak with it. '
          : 'Then speak your line. '}
        The recording stops automatically at the length of the original line.
        {requireTake ? ' You cannot go back to a line after you press Next.' : ''}
      </p>
    </section>
  )
}
