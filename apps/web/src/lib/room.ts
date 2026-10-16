import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import {
  ServerEvents,
  type Ack,
  type AssetStatus,
  type JobView,
  type PackManifest,
  type PlayerView,
  type ProgressView,
  type RoomView,
  type SessionResponse,
} from '@mcv/shared'
import { api } from './api'
import { syncClock } from './clock'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'unauthorized'
export type EndReason = 'kicked' | 'closed' | null

export interface RoomConnection {
  room: RoomView | null
  connection: ConnectionState
  ended: EndReason
  command: (event: string, payload?: unknown) => Promise<Record<string, unknown>>
  emit: (event: string, payload: unknown) => void
}

function patchPlayer(room: RoomView, playerId: string, patch: Partial<PlayerView>): RoomView {
  return {
    ...room,
    players: room.players.map((player) => (player.id === playerId ? { ...player, ...patch } : player)),
  }
}

export function useRoomConnection(session: SessionResponse | null): RoomConnection {
  const [room, setRoom] = useState<RoomView | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [ended, setEnded] = useState<EndReason>(null)
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    if (!session) return
    const socket = io({
      transports: ['websocket'],
      auth: { code: session.code, token: session.token },
      reconnectionDelayMax: 5000,
    })
    socketRef.current = socket
    socket.on('connect', () => {
      setConnection('connected')
      void syncClock(socket)
    })
    socket.on('disconnect', () => setConnection('disconnected'))
    socket.on('connect_error', (error: Error) => {
      if (error.message === 'unauthorized') {
        setConnection('unauthorized')
        socket.disconnect()
      } else {
        setConnection('disconnected')
      }
    })
    socket.on(ServerEvents.state, (view: RoomView) => setRoom(view))
    socket.on(ServerEvents.progress, ({ playerId, progress }: { playerId: string; progress: ProgressView }) =>
      setRoom((current) => (current ? patchPlayer(current, playerId, { progress }) : current)),
    )
    socket.on(ServerEvents.assets, ({ playerId, assets }: { playerId: string; assets: AssetStatus }) =>
      setRoom((current) => (current ? patchPlayer(current, playerId, { assets }) : current)),
    )
    socket.on(ServerEvents.job, (job: JobView) => setRoom((current) => (current ? { ...current, job } : current)))
    socket.on(ServerEvents.video, ({ packId, progress }: { packId: string; progress: number }) =>
      setRoom((current) =>
        current?.pack?.id === packId
          ? { ...current, pack: { ...current.pack, videoStatus: 'processing', videoProgress: progress } }
          : current,
      ),
    )
    socket.on(ServerEvents.kicked, () => setEnded('kicked'))
    socket.on(ServerEvents.closed, () => setEnded('closed'))
    const resync = window.setInterval(() => {
      if (socket.connected) void syncClock(socket, 3)
    }, 60_000)
    return () => {
      window.clearInterval(resync)
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
  }, [session])

  const command = useCallback((event: string, payload: unknown = {}) => {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = socketRef.current
      if (!socket?.connected) {
        reject(new Error('Not connected. Wait a moment and try again.'))
        return
      }
      socket.timeout(15_000).emit(event, payload, (error: unknown, response: (Ack & Record<string, unknown>) | undefined) => {
        if (error) reject(new Error('The server did not answer'))
        else if (!response?.ok) reject(new Error(response?.error ?? 'The request failed'))
        else resolve(response)
      })
    })
  }, [])

  const emit = useCallback((event: string, payload: unknown) => {
    socketRef.current?.volatile.emit(event, payload)
  }, [])

  return { room, connection, ended, command, emit }
}

export interface RoomContextValue extends RoomConnection {
  room: RoomView
  session: SessionResponse
  me: PlayerView | null
  isHost: boolean
  manifest: PackManifest | null
  roundManifest: PackManifest | null
  notify: (message: string, kind?: 'error' | 'info') => void
}

export const RoomContext = createContext<RoomContextValue | null>(null)

export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext)
  if (!value) throw new Error('useRoom outside RoomContext')
  return value
}

const manifestCache = new Map<string, PackManifest>()

/** Loads a pack manifest. `version` forces a reload (for example when the video becomes ready). */
export function useManifest(packId: string | null | undefined, version: string): PackManifest | null {
  const [manifest, setManifest] = useState<PackManifest | null>(() =>
    packId ? (manifestCache.get(`${packId}:${version}`) ?? null) : null,
  )
  useEffect(() => {
    if (!packId) {
      setManifest(null)
      return
    }
    const key = `${packId}:${version}`
    const cached = manifestCache.get(key)
    if (cached) {
      setManifest(cached)
      return
    }
    let cancelled = false
    void api<PackManifest>(`/api/packs/${encodeURIComponent(packId)}`)
      .then((value) => {
        manifestCache.set(key, value)
        if (!cancelled) setManifest(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [packId, version])
  return manifest?.id === packId ? manifest : null
}
