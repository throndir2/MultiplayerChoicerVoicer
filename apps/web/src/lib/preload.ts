import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ClientEvents, type AssetStatus, type PackManifest, type PlayerView, type RoomView } from '@mcv/shared'
import { assets } from './assets'

function fraction(url: string | null | undefined, sizeHint: number): { loaded: number; total: number } {
  if (!url) return { loaded: 0, total: 0 }
  const state = assets.state(url)
  const total = state.total || sizeHint || 1
  if (state.status === 'done') return { loaded: total, total }
  return { loaded: Math.min(state.loaded, total), total }
}

export function useAssetsVersion(): number {
  return useSyncExternalStore(assets.subscribe, assets.getVersion)
}

/**
 * Starts the downloads for the current pack and round, in priority order, and reports
 * the progress to the server so the other players can see it.
 */
export function usePreloader(
  room: RoomView,
  manifest: PackManifest | null,
  me: PlayerView | null,
  emit: (event: string, payload: unknown) => void,
): void {
  const version = useAssetsVersion()
  const round = room.round && manifest && room.round.packId === manifest.id ? room.round : null
  const myLineKey = round
    ? round.dubs
        .flatMap((dub) => Object.entries(dub.assignments).filter(([, playerId]) => playerId === me?.id))
        .map(([lineId]) => lineId)
        .join(',')
    : ''

  useEffect(() => {
    if (!manifest) return
    const packPrefix = `/media/packs/${encodeURIComponent(manifest.id)}/`
    assets.dropQueued((url) => !url.startsWith('/media/packs/') || url.startsWith(packPrefix))
    const mine = new Set(myLineKey ? myLineKey.split(',') : [])
    manifest.lines.forEach((line, index) => {
      const base = !round ? 20 : mine.has(line.id) ? 10 : 40
      const priority = base + index / 10_000
      assets.prefetch(line.imageUrl, priority, line.imageBytes)
      assets.prefetch(line.promptUrl, priority, line.promptBytes)
    })
    assets.prefetch(manifest.backingUrl, 30, manifest.backingBytes)
    assets.prefetch(manifest.iconUrl, 15)
    if (manifest.videoUrl) assets.prefetch(manifest.videoUrl, 50, manifest.videoBytes)
  }, [manifest, myLineKey, round])

  const recordingKey = round
    ? round.dubs.flatMap((dub) => Object.values(dub.recordings).map((recording) => recording.url)).join('|')
    : ''
  useEffect(() => {
    if (!recordingKey) return
    for (const url of recordingKey.split('|')) assets.prefetch(url, 25)
  }, [recordingKey])

  useEffect(() => {
    if (round) void assets.persist()
  }, [round?.id])

  const lastSent = useRef<{ at: number; key: string }>({ at: 0, key: '' })
  useEffect(() => {
    if (!manifest || !me) return
    const mine = new Set(myLineKey ? myLineKey.split(',') : [])
    let loaded = 0
    let total = 0
    for (const line of manifest.lines) {
      if (round && !mine.has(line.id)) continue
      for (const part of [fraction(line.imageUrl, line.imageBytes), fraction(line.promptUrl, line.promptBytes)]) {
        loaded += part.loaded
        total += part.total
      }
    }
    const backing = manifest.backingUrl ? fraction(manifest.backingUrl, manifest.backingBytes) : { loaded: 1, total: 1 }
    const video = manifest.videoUrl ? fraction(manifest.videoUrl, manifest.videoBytes) : { loaded: 0, total: 1 }
    const urls = recordingKey ? recordingKey.split('|') : []
    const recordingsDone = urls.filter((url) => assets.isDone(url)).length
    const status: AssetStatus = {
      packId: manifest.id,
      lines: total > 0 ? Math.min(1, loaded / total) : 1,
      backing: backing.total > 0 ? Math.min(1, backing.loaded / backing.total) : 1,
      video: video.total > 0 ? Math.min(1, video.loaded / video.total) : 0,
      recordings: urls.length > 0 ? recordingsDone / urls.length : 1,
      ready: false,
    }
    status.ready = status.lines >= 1 && status.backing >= 1 && status.video >= 1 && status.recordings >= 1
    const key = [status.packId, status.lines, status.backing, status.video, status.recordings]
      .map((value) => (typeof value === 'number' ? value.toFixed(2) : value))
      .join(':')
    const now = Date.now()
    if (key !== lastSent.current.key && (now - lastSent.current.at > 1000 || status.ready)) {
      lastSent.current = { at: now, key }
      emit(ClientEvents.assetsUpdate, status)
    }
  }, [version, manifest, me, myLineKey, recordingKey, round, emit])
}
