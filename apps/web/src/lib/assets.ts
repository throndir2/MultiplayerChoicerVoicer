/**
 * The asset manager downloads pack media and recordings into the browser's private
 * Cache Storage. It works in priority order, runs a few downloads at the same time,
 * and continues a broken download with an HTTP Range request.
 */

type EntryStatus = 'queued' | 'loading' | 'done' | 'error'

interface Entry {
  url: string
  priority: number
  status: EntryStatus
  loaded: number
  total: number
  sizeHint: number
  blob: Blob | null
  objectUrl: string | null
  promise: Promise<Blob>
  resolve: (blob: Blob) => void
  reject: (error: Error) => void
  error: string | null
}

export interface AssetState {
  status: EntryStatus | 'none'
  loaded: number
  total: number
}

/** A file in the Cache Storage of the site. `path` is the URL path, for example `/media/packs/<id>/x.png`. */
export interface StoredFile {
  path: string
  size: number
  lastUsed: number
}

const CACHE_NAME = 'mcv-media-v1'
const INDEX_KEY = 'mcv:asset-index'
export const MAX_AGE_MS = 7 * 24 * 3_600_000
const MAX_ACTIVE = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pathOf(url: string): string {
  return new URL(url, window.location.href).pathname
}

class AssetStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private active = 0
  private notifyScheduled = false
  private readonly cache: Promise<Cache | null>
  private index: Record<string, number> = {}
  private indexDirty = false
  version = 0
  /** Goes up each time files are deleted, so the preloader requests the files of the room again. */
  generation = 0

  constructor() {
    this.cache =
      typeof caches !== 'undefined' && window.isSecureContext
        ? caches.open(CACHE_NAME).catch(() => null)
        : Promise.resolve(null)
    try {
      this.index = JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? '{}') as Record<string, number>
    } catch {
      this.index = {}
    }
    void this.prune()
    window.setInterval(() => this.saveIndex(), 10_000)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private notify(): void {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    window.setTimeout(() => {
      this.notifyScheduled = false
      this.version += 1
      for (const listener of this.listeners) listener()
    }, 200)
  }

  private touch(url: string): void {
    this.index[url] = Date.now()
    this.indexDirty = true
  }

  private saveIndex(): void {
    if (!this.indexDirty) return
    this.indexDirty = false
    try {
      window.localStorage.setItem(INDEX_KEY, JSON.stringify(this.index))
    } catch {
      // Storage full: the index is only an optimisation.
    }
  }

  private async prune(): Promise<void> {
    const cache = await this.cache
    if (!cache) return
    const limit = Date.now() - MAX_AGE_MS
    const keys = await cache.keys()
    for (const request of keys) {
      const path = new URL(request.url).pathname
      const used = this.index[path] ?? 0
      if (used < limit) {
        await cache.delete(request)
        delete this.index[path]
        this.indexDirty = true
      }
    }
  }

  /** Ask the browser not to clear our storage while it is low on space. */
  async persist(): Promise<void> {
    try {
      if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
        await navigator.storage.persist?.()
      }
    } catch {
      // Not supported.
    }
  }

  /** The files on disk, or null when the browser does not keep files for this site. */
  async listStored(): Promise<StoredFile[] | null> {
    const cache = await this.cache
    if (!cache) return null
    const files: StoredFile[] = []
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname
      let size = 0
      try {
        const response = await cache.match(request)
        if (response) size = Number(response.headers.get('content-length')) || (await response.blob()).size
      } catch {
        size = 0
      }
      files.push({ path, size, lastUsed: this.index[path] ?? 0 })
    }
    return files
  }

  /**
   * Deletes the files whose URL path matches, from the disk and from memory. Waiting and
   * running downloads of these files stop. The preloader of an open room requests the
   * files of the room again when `generation` changes.
   */
  async deleteFiles(match: (path: string) => boolean): Promise<void> {
    for (const [url, entry] of this.entries) {
      if (!match(pathOf(url))) continue
      this.entries.delete(url)
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl)
      if (entry.status === 'queued' || entry.status === 'loading') entry.reject(new Error('cancelled'))
    }
    for (const path of Object.keys(this.index)) {
      if (match(path)) delete this.index[path]
    }
    this.indexDirty = true
    this.saveIndex()
    const cache = await this.cache
    if (cache) {
      for (const request of await cache.keys()) {
        if (match(new URL(request.url).pathname)) await cache.delete(request).catch(() => false)
      }
    }
    this.generation += 1
    this.notify()
  }

  clearAll(): Promise<void> {
    return this.deleteFiles(() => true)
  }

  async usage(): Promise<{ usage: number; quota: number } | null> {
    try {
      const estimate = await navigator.storage?.estimate?.()
      return estimate ? { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 } : null
    } catch {
      return null
    }
  }

  /** Returns the file, downloading it if necessary. A lower priority number is sooner. */
  request(url: string, priority = 0, sizeHint = 0): Promise<Blob> {
    let entry = this.entries.get(url)
    if (!entry) {
      let resolve!: (blob: Blob) => void
      let reject!: (error: Error) => void
      const promise = new Promise<Blob>((ok, fail) => {
        resolve = ok
        reject = fail
      })
      promise.catch(() => undefined)
      entry = {
        url,
        priority,
        status: 'queued',
        loaded: 0,
        total: sizeHint,
        sizeHint,
        blob: null,
        objectUrl: null,
        promise,
        resolve,
        reject,
        error: null,
      }
      this.entries.set(url, entry)
      this.notify()
    } else {
      entry.priority = Math.min(entry.priority, priority)
      if (entry.status === 'error') {
        entry.status = 'queued'
        entry.error = null
        const fresh = new Promise<Blob>((ok, fail) => {
          entry!.resolve = ok
          entry!.reject = fail
        })
        fresh.catch(() => undefined)
        entry.promise = fresh
      }
    }
    this.touch(url)
    this.pump()
    return entry.promise
  }

  prefetch(url: string | null | undefined, priority: number, sizeHint = 0): void {
    if (!url) return
    void this.request(url, priority, sizeHint).catch(() => undefined)
  }

  /** Removes waiting downloads that are not needed any more (for example after the host changes the pack). */
  dropQueued(keep: (url: string) => boolean): void {
    for (const [url, entry] of this.entries) {
      if (entry.status === 'queued' && !keep(url)) {
        this.entries.delete(url)
        entry.reject(new Error('cancelled'))
      }
    }
  }

  state(url: string | null | undefined): AssetState {
    if (!url) return { status: 'none', loaded: 0, total: 0 }
    const entry = this.entries.get(url)
    if (!entry) return { status: 'none', loaded: 0, total: 0 }
    return { status: entry.status, loaded: entry.loaded, total: entry.total || entry.sizeHint }
  }

  isDone(url: string | null | undefined): boolean {
    return Boolean(url && this.entries.get(url)?.status === 'done')
  }

  /** A blob: URL for a finished file, or null. */
  objectUrl(url: string | null | undefined): string | null {
    if (!url) return null
    const entry = this.entries.get(url)
    if (!entry?.blob) return null
    entry.objectUrl ??= URL.createObjectURL(entry.blob)
    return entry.objectUrl
  }

  private pump(): void {
    while (this.active < MAX_ACTIVE) {
      let next: Entry | null = null
      for (const entry of this.entries.values()) {
        if (entry.status === 'queued' && (!next || entry.priority < next.priority)) next = entry
      }
      if (!next) return
      next.status = 'loading'
      this.active += 1
      void this.load(next).finally(() => {
        this.active -= 1
        this.notify()
        this.pump()
      })
    }
  }

  /** False after `deleteFiles` removed the entry: its result must not go back into the cache. */
  private isCurrent(entry: Entry): boolean {
    return this.entries.get(entry.url) === entry
  }

  private async load(entry: Entry): Promise<void> {
    const cache = await this.cache
    try {
      if (cache) {
        const cached = await cache.match(entry.url)
        if (cached) {
          const blob = await cached.blob()
          this.finish(entry, blob)
          return
        }
      }
      const blob = await this.download(entry)
      if (!this.isCurrent(entry)) return
      let stored: Blob = blob
      if (cache) {
        try {
          await cache.put(
            entry.url,
            new Response(blob, { headers: { 'content-type': blob.type, 'content-length': String(blob.size) } }),
          )
          if (!this.isCurrent(entry)) {
            await cache.delete(entry.url)
            return
          }
          // Re-reading gives a disk-backed blob, so the downloaded chunks can be freed.
          const again = await cache.match(entry.url)
          if (again) stored = await again.blob()
        } catch {
          // Quota exceeded: keep the file in memory only.
        }
      }
      this.finish(entry, stored)
    } catch (error) {
      entry.status = 'error'
      entry.error = error instanceof Error ? error.message : 'Download failed'
      entry.reject(error instanceof Error ? error : new Error('Download failed'))
    }
  }

  private finish(entry: Entry, blob: Blob): void {
    entry.blob = blob
    entry.loaded = blob.size
    entry.total = blob.size
    entry.status = 'done'
    entry.resolve(blob)
  }

  private async download(entry: Entry): Promise<Blob> {
    let chunks: Uint8Array[] = []
    let received = 0
    let type = ''
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const headers: Record<string, string> = {}
        if (received > 0) headers.range = `bytes=${received}-`
        const response = await fetch(entry.url, { headers })
        if (response.status === 404) throw new Error('not-found')
        if (received > 0 && response.status !== 206) {
          chunks = []
          received = 0
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        type = response.headers.get('content-type') ?? type
        const length = Number(response.headers.get('content-length')) || 0
        if (length) entry.total = received + length
        const reader = response.body.getReader()
        for (;;) {
          if (!this.isCurrent(entry)) {
            void reader.cancel().catch(() => undefined)
            throw new Error('cancelled')
          }
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          entry.loaded = received
          this.notify()
        }
        if (entry.total && received < entry.total) throw new Error('Connection closed early')
        return new Blob(chunks as BlobPart[], { type })
      } catch (error) {
        if (error instanceof Error && (error.message === 'not-found' || error.message === 'cancelled')) throw error
        if (!this.isCurrent(entry)) throw new Error('cancelled')
        await sleep(Math.min(15_000, 800 * 2 ** attempt))
      }
    }
    throw new Error('Download failed after several attempts')
  }
}

export const assets = new AssetStore()
