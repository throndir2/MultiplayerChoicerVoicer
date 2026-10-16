import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import type { RoomPhase, SessionResponse } from '@mcv/shared'
import { clearSession, loadSession } from '../lib/api'
import { usePreloader } from '../lib/preload'
import { RoomContext, useManifest, useRoomConnection, type RoomConnection, type RoomContextValue } from '../lib/room'
import { roomInUse, useLeaveCleanup } from '../lib/storage'
import { StorageButton } from '../components/StoragePanel'
import { Lobby } from '../room/Lobby'
import { PlaybackView } from '../room/PlaybackView'
import { RecordingView } from '../room/RecordingView'
import { ResultsView } from '../room/ResultsView'
import { VotingView } from '../room/VotingView'

const STEPS: { phase: RoomPhase; label: string }[] = [
  { phase: 'lobby', label: 'Lobby' },
  { phase: 'recording', label: 'Record' },
  { phase: 'playback', label: 'Watch' },
  { phase: 'voting', label: 'Vote' },
  { phase: 'results', label: 'Results' },
]

interface Toast {
  id: number
  message: string
  kind: 'error' | 'info'
}

export function RoomScreen({ code }: { code: string }) {
  const [, navigate] = useLocation()
  const session = useMemo(() => loadSession(code), [code])
  const connection = useRoomConnection(session)
  useLeaveCleanup(code)

  useEffect(() => {
    if (!session) navigate(`/join/${code}`, { replace: true })
  }, [session, code, navigate])

  useEffect(() => {
    if (connection.connection === 'unauthorized') {
      clearSession(code)
      navigate(`/join/${code}`, { replace: true })
    }
  }, [connection.connection, code, navigate])

  if (!session) return null
  if (connection.ended) {
    return (
      <div className="center-screen">
        <div className="card">
          <h2>{connection.ended === 'kicked' ? 'The host removed you from the room' : 'This room has closed'}</h2>
          <Link className="button button--primary" href="/" onClick={() => clearSession(code)}>
            Back to the start
          </Link>
        </div>
      </div>
    )
  }
  if (!connection.room) {
    return (
      <div className="center-screen">
        <div className="spinner" aria-label="Connecting" />
        <p>Connecting to room {code}…</p>
      </div>
    )
  }
  return <RoomShell connection={connection} session={session} />
}

function RoomShell({ connection, session }: { connection: RoomConnection; session: SessionResponse }) {
  const room = connection.room
  if (!room) throw new Error('room missing')
  const me = room.players.find((player) => player.id === session.playerId) ?? null
  const isHost = room.hostId === session.playerId
  const manifest = useManifest(room.pack?.id, room.pack?.videoStatus ?? '')
  const roundPackId = room.round?.packId
  const roundManifest = useManifest(
    roundPackId,
    roundPackId && roundPackId === room.pack?.id ? (room.pack?.videoStatus ?? '') : 'round',
  )
  usePreloader(room, room.round ? roundManifest : manifest, me, connection.emit)

  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const notify = useCallback((message: string, kind: 'error' | 'info' = 'error') => {
    const id = nextId.current++
    setToasts((current) => [...current.slice(-3), { id, message, kind }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5000)
  }, [])

  const value: RoomContextValue = {
    ...connection,
    room,
    session,
    me,
    isHost,
    manifest,
    roundManifest,
    notify,
  }

  const activeIndex = STEPS.findIndex((step) => step.phase === room.phase)

  return (
    <RoomContext.Provider value={value}>
      <div className="room">
        <header className="topbar">
          <Link href="/" className="topbar__brand">
            🎙️ Choicer Voicer Party
          </Link>
          <ol className="steps" aria-label="Game stages">
            {STEPS.filter((step) => step.phase !== 'voting' || room.round?.mode === 'versus' || room.phase === 'voting').map(
              (step) => {
                const index = STEPS.findIndex((entry) => entry.phase === step.phase)
                return (
                  <li
                    key={step.phase}
                    className={index === activeIndex ? 'is-active' : index < activeIndex ? 'is-done' : ''}
                  >
                    {step.label}
                  </li>
                )
              },
            )}
          </ol>
          <span className="topbar__code" title="Room code">
            {room.code}
          </span>
          <StorageButton className="icon-button" label="💾" inUse={roomInUse(room)} />
        </header>
        {connection.connection !== 'connected' && (
          <div className="banner" role="status">
            Connection lost. Reconnecting…
          </div>
        )}
        <main className="room__main">
          {room.phase === 'lobby' && <Lobby />}
          {room.phase === 'recording' && <RecordingView />}
          {room.phase === 'playback' && <PlaybackView />}
          {room.phase === 'voting' && <VotingView />}
          {room.phase === 'results' && <ResultsView />}
        </main>
        <div className="toasts" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast--${toast.kind}`}>
              {toast.message}
            </div>
          ))}
        </div>
      </div>
    </RoomContext.Provider>
  )
}
