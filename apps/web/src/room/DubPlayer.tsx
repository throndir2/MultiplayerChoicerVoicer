import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  activeCues,
  buildCues,
  formatSeconds,
  type Cue,
  type DubView,
  type PackManifest,
  type PlaybackState,
  type PlayerView,
} from '@mcv/shared'
import { ProgressBar, percent } from '../components/ui'
import { assets } from '../lib/assets'
import { audioContext, decodeUrl, unlockAudio } from '../lib/audio'
import { clockOffset } from '../lib/clock'

interface Prepared {
  backing: AudioBuffer | null
  voices: { cue: Cue; buffer: AudioBuffer | null }[]
}

export interface HostControls {
  play: (position?: number) => void
  pause: () => void
  seek: (position: number) => void
}

interface Props {
  manifest: PackManifest
  dub: DubView
  fillMissing: boolean
  players: PlayerView[]
  /** Follow the server playback state. Without it, the player has its own local controls. */
  synced?: PlaybackState | null
  hostControls?: HostControls | null
  autoPlay?: boolean
  onEnded?: () => void
}

const SUBS_KEY = 'mcv:subtitles'
const VOLUME_KEY = 'mcv:volume'

export function DubPlayer({ manifest, dub, fillMissing, players, synced, hostControls, autoPlay, onEnded }: Props) {
  const isSynced = synced !== undefined
  const videoRef = useRef<HTMLVideoElement>(null)
  const cues = useMemo(() => buildCues(manifest, dub, fillMissing), [manifest, dub, fillMissing])
  const audioKey = `${manifest.backingUrl ?? ''}|${cues.map((cue) => cue.url ?? '-').join('|')}`
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [loadProgress, setLoadProgress] = useState(0)
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [ended, setEnded] = useState(false)
  const [needsUnlock, setNeedsUnlock] = useState(false)
  const [subtitles, setSubtitles] = useState(() => window.localStorage.getItem(SUBS_KEY) !== 'off')
  const [volume, setVolume] = useState(() => Number(window.localStorage.getItem(VOLUME_KEY) ?? '1'))
  const [videoSrc] = useState(() =>
    manifest.videoUrl ? (assets.objectUrl(manifest.videoUrl) ?? manifest.videoUrl) : null,
  )

  const engine = useRef({
    sources: [] as AudioBufferSourceNode[],
    gain: null as GainNode | null,
    startCtx: 0,
    startOffset: 0,
    playing: false,
    lastCorrection: 0,
  })
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded
  const duration = manifest.duration
  const names = useMemo(() => new Map(players.map((player) => [player.id, player])), [players])

  // Download and decode every sound of this dub.
  useEffect(() => {
    let cancelled = false
    setPrepared(null)
    setLoadProgress(0)
    const urls = [...new Set([manifest.backingUrl, ...cues.map((cue) => cue.url)].filter((url): url is string => Boolean(url)))]
    let done = 0
    const buffers = new Map<string, AudioBuffer | null>()
    void Promise.all(
      urls.map((url) =>
        decodeUrl(url, 5)
          .then((buffer) => buffers.set(url, buffer))
          .catch(() => buffers.set(url, null))
          .finally(() => {
            done += 1
            if (!cancelled) setLoadProgress(done / Math.max(1, urls.length))
          }),
      ),
    ).then(() => {
      if (cancelled) return
      setPrepared({
        backing: manifest.backingUrl ? (buffers.get(manifest.backingUrl) ?? null) : null,
        voices: cues.map((cue) => ({ cue, buffer: cue.url ? (buffers.get(cue.url) ?? null) : null })),
      })
    })
    return () => {
      cancelled = true
    }
    // `audioKey` changes when the sound files of the dub change.
  }, [audioKey])

  const currentPosition = useCallback(() => {
    const state = engine.current
    if (!state.playing) return state.startOffset
    return state.startOffset + (audioContext().currentTime - state.startCtx)
  }, [])

  const stopSources = useCallback(() => {
    for (const source of engine.current.sources) {
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
    }
    engine.current.sources = []
  }, [])

  const pauseAt = useCallback(
    (offset: number) => {
      stopSources()
      engine.current.playing = false
      engine.current.startOffset = Math.max(0, Math.min(duration, offset))
      setPlaying(false)
      setPosition(engine.current.startOffset)
      const video = videoRef.current
      if (video) {
        video.pause()
        if (Number.isFinite(video.duration)) video.currentTime = Math.min(engine.current.startOffset, video.duration)
      }
    },
    [duration, stopSources],
  )

  const startAt = useCallback(
    (offset: number, delaySeconds: number) => {
      if (!prepared) return
      stopSources()
      const ctx = audioContext()
      if (ctx.state !== 'running') {
        void ctx.resume().catch(() => undefined)
        // Browsers block sound until the user clicks on the page at least once.
        window.setTimeout(() => setNeedsUnlock(audioContext().state !== 'running'), 400)
      }
      const gain = ctx.createGain()
      gain.gain.value = volume
      gain.connect(ctx.destination)
      engine.current.gain = gain
      const when = ctx.currentTime + Math.max(0, delaySeconds) + 0.03
      const sources: AudioBufferSourceNode[] = []
      const schedule = (buffer: AudioBuffer, at: number) => {
        const end = at + buffer.duration
        if (end <= offset) return
        const source = ctx.createBufferSource()
        source.buffer = buffer
        source.connect(gain)
        if (at >= offset) source.start(when + (at - offset))
        else source.start(when, offset - at)
        sources.push(source)
      }
      if (prepared.backing) schedule(prepared.backing, 0)
      for (const voice of prepared.voices) if (voice.buffer) schedule(voice.buffer, voice.cue.time)
      engine.current.sources = sources
      engine.current.startCtx = when
      engine.current.startOffset = offset
      engine.current.playing = true
      setPlaying(true)
      setEnded(false)
      const video = videoRef.current
      if (video) {
        video.muted = true
        video.playbackRate = 1
        video.currentTime = offset
        const begin = () => void video.play().catch(() => undefined)
        if (delaySeconds > 0.05) window.setTimeout(begin, delaySeconds * 1000)
        else begin()
      }
    },
    [prepared, stopSources, volume],
  )

  // Follow the server state.
  useEffect(() => {
    if (!isSynced || !prepared) return
    if (!synced) {
      pauseAt(0)
      return
    }
    if (synced.status === 'playing') {
      const startLocal = synced.startedAt - clockOffset()
      const delayMs = startLocal - Date.now()
      if (delayMs > 0) startAt(synced.position, delayMs / 1000)
      else {
        const offset = synced.position + -delayMs / 1000
        if (offset >= duration) pauseAt(duration)
        else startAt(offset, 0)
      }
    } else {
      pauseAt(synced.position)
    }
    // `seq` changes with every host action.
  }, [isSynced, synced?.seq, synced?.dubId, prepared])

  useEffect(() => {
    if (!isSynced && autoPlay && prepared) startAt(0, 0.2)
  }, [prepared])

  useEffect(() => () => stopSources(), [stopSources])

  useEffect(() => {
    if (engine.current.gain) engine.current.gain.gain.value = volume
    window.localStorage.setItem(VOLUME_KEY, String(volume))
  }, [volume])

  // Clock loop: subtitles, the end of the dub and video drift correction. A timer (not
  // requestAnimationFrame) keeps it running when the tab is in the background.
  useEffect(() => {
    let lastUi = 0
    const tick = () => {
      const now = performance.now()
      const state = engine.current
      const pos = currentPosition()
      if (state.playing && pos >= duration) {
        stopSources()
        state.playing = false
        state.startOffset = duration
        videoRef.current?.pause()
        setPlaying(false)
        setEnded(true)
        onEndedRef.current?.()
      }
      const video = videoRef.current
      if (video && state.playing && pos >= 0 && now - state.lastCorrection > 400 && !video.seeking && video.readyState >= 2) {
        state.lastCorrection = now
        const drift = video.currentTime - pos
        if (Math.abs(drift) > 0.3) {
          video.currentTime = Math.max(0, pos + 0.05)
          video.playbackRate = 1
        } else if (Math.abs(drift) > 0.04) {
          video.playbackRate = Math.max(0.9, Math.min(1.1, 1 - drift * 0.5))
        } else {
          video.playbackRate = 1
        }
        if (video.paused && pos < (Number.isFinite(video.duration) ? video.duration : duration)) {
          void video.play().catch(() => undefined)
        }
      }
      if (now - lastUi > 90) {
        lastUi = now
        setPosition(Math.max(0, Math.min(duration, pos)))
      }
    }
    const timer = window.setInterval(tick, 50)
    return () => window.clearInterval(timer)
  }, [currentPosition, duration, stopSources])

  const active = subtitles ? activeCues(cues, position) : []
  const lastCue = [...cues].reverse().find((cue) => cue.time <= position) ?? cues[0]
  const fallbackImage = manifest.lines.find((line) => line.id === lastCue?.lineId)?.imageUrl ?? manifest.iconUrl
  const canControl = !isSynced || Boolean(hostControls)

  function togglePlay() {
    void unlockAudio().then(() => setNeedsUnlock(false))
    if (isSynced) {
      if (!hostControls) return
      if (playing) hostControls.pause()
      else hostControls.play(ended ? 0 : undefined)
      return
    }
    if (playing) pauseAt(currentPosition())
    else startAt(ended || position >= duration - 0.05 ? 0 : position, 0.05)
  }

  function seek(value: number) {
    if (isSynced) {
      hostControls?.seek(value)
      return
    }
    if (engine.current.playing) startAt(value, 0.05)
    else pauseAt(value)
  }

  return (
    <div className="player">
      <div className="stage stage--player">
        {videoSrc ? (
          <video ref={videoRef} src={videoSrc} muted playsInline preload="auto" />
        ) : (
          fallbackImage && <img src={assets.objectUrl(fallbackImage) ?? fallbackImage} alt="" />
        )}
        {active.length > 0 && (
          <div className="subtitles">
            {active.slice(-2).map((cue) => {
              const voice = cue.playerId ? names.get(cue.playerId) : undefined
              return (
                <div key={cue.key} className="subtitle">
                  <span className="subtitle__speaker" style={{ color: voice?.color }}>
                    {cue.characters.join(' & ')}
                  </span>{' '}
                  {cue.text}
                  <span className="subtitle__voice">
                    {cue.original ? ' · original' : voice ? ` · 🎙 ${voice.name}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {!prepared && (
          <div className="stage__overlay">
            <ProgressBar value={loadProgress} label={`Preparing the audio ${percent(loadProgress)}`} />
          </div>
        )}
        {prepared && needsUnlock && (
          <button
            type="button"
            className="stage__overlay stage__overlay--button"
            onClick={() =>
              void unlockAudio().then((ok) => {
                setNeedsUnlock(!ok)
                if (ok && synced?.status === 'playing') {
                  const offset = synced.position + (Date.now() - (synced.startedAt - clockOffset())) / 1000
                  startAt(Math.max(0, offset), 0)
                }
              })
            }
          >
            🔊 Click to turn on the sound
          </button>
        )}
        {prepared && !playing && isSynced && !hostControls && !ended && (
          <div className="stage__badge">Waiting for the host…</div>
        )}
        {ended && <div className="stage__badge">The end</div>}
      </div>
      <div className="player__controls">
        {canControl && (
          <button type="button" className="button button--primary" onClick={togglePlay} disabled={!prepared}>
            {playing ? '❚❚ Pause' : ended ? '↺ Again' : '▶ Play'}
          </button>
        )}
        <span className="player__time">
          {formatSeconds(position)} / {formatSeconds(duration)}
        </span>
        <input
          className="player__seek"
          type="range"
          min={0}
          max={duration}
          step={0.1}
          value={position}
          disabled={!canControl || !prepared}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="Position"
        />
        <label className="toggle toggle--inline">
          <input
            type="checkbox"
            checked={subtitles}
            onChange={(event) => {
              setSubtitles(event.target.checked)
              window.localStorage.setItem(SUBS_KEY, event.target.checked ? 'on' : 'off')
            }}
          />
          <span>Subtitles</span>
        </label>
        <label className="player__volume">
          🔈
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
            aria-label="Volume"
          />
        </label>
      </div>
      {!videoSrc && (
        <p className="hint">
          {manifest.videoStatus === 'error'
            ? 'The video could not be converted, so the player shows the line images.'
            : 'The video is still being converted on the server, so the player shows the line images.'}
        </p>
      )}
    </div>
  )
}
