import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ClientEvents, type AssetStatus, type PackManifest, type PlayerView, type RoomView } from '@mcv/shared'
import { assets } from './assets'
import { loadManifest } from './room'

/** Bytes of a pack that are on this device, and the size of the pack. */
export function packDownload(manifest: PackManifest): { loaded: number; total: number } {
  let loaded = 0
  let total = 0
  const parts: [string | null, number][] = [
    [manifest.videoUrl, manifest.videoBytes],
    [manifest.backingUrl, manifest.backingBytes],
    ...manifest.lines.flatMap((line): [string | null, number][] => [
      [line.imageUrl, line.imageBytes],
      [line.promptUrl, line.promptBytes],
    ]),
  ]
  for (const [url, size] of parts) {
    if (!url) continue
    const part = fraction(url, size)
    loaded += part.loaded
    total += size || part.total
  }
  return { loaded, total }
}

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

  const queueKey = room.queue
    .map((entry) => (entry.pack ? `${entry.pack.id}:${entry.pack.videoStatus}` : ''))
    .filter(Boolean)
    .join('|')

  useEffect(() => {
    if (!manifest) return
    const packPrefix = `/media/packs/${encodeURIComponent(manifest.id)}/`
    const queuePrefixes = queueKey
      .split('|')
      .filter(Boolean)
      .map((item) => `/media/packs/${encodeURIComponent(item.split(':')[0] ?? '')}/`)
    assets.dropQueued(
      (url) =>
        !url.startsWith('/media/packs/') ||
        url.startsWith(packPrefix) ||
        queuePrefixes.some((prefix) => url.startsWith(prefix)),
    )
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
  }, [manifest, myLineKey, round, queueKey])

  // Queued packs download after every file of the current pack, in queue order.
  useEffect(() => {
    if (!queueKey) return
    let cancelled = false
    queueKey.split('|').forEach((item, order) => {
      const [packId = '', videoStatus = ''] = item.split(':')
      void loadManifest(packId, videoStatus).then((queued) => {
        if (cancelled || !queued) return
        const base = 100 + order * 10
        assets.prefetch(queued.iconUrl, base)
        queued.lines.forEach((line, index) => {
          assets.prefetch(line.imageUrl, base + 1 + index / 10_000, line.imageBytes)
          assets.prefetch(line.promptUrl, base + 1 + index / 10_000, line.promptBytes)
        })
        assets.prefetch(queued.backingUrl, base + 2, queued.backingBytes)
        if (queued.videoUrl) assets.prefetch(queued.videoUrl, base + 3, queued.videoBytes)
      })
    })
    return () => {
      cancelled = true
    }
  }, [queueKey])

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
