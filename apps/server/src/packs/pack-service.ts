import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { packVersionDate, packVersionKey, type JobView, type PackManifest, type PackSourceInfo, type PackSummary } from '@mcv/shared'
import type { AppConfig } from '../config.js'
import { GAMEBANANA_HOSTS, type GameBananaClient } from '../catalog/gamebanana.js'
import { downloadToFile } from '../util/download.js'
import {
  dirSize,
  ensureDir,
  exists,
  makeTreeWritable,
  readJson,
  removeDir,
  walkFiles,
  writeJsonAtomic,
} from '../util/fsx.js'
import { randomId, shortHash } from '../util/ids.js'
import type { Media } from '../util/media.js'
import { findArchives, findPackDirs, fingerprintPack, readPack } from './discover.js'
import { MANIFEST_FILE, processPackPhaseA, processPackPhaseB } from './processor.js'

interface JobRecord extends JobView {
  source: PackSourceInfo
  updatedAt: number
}

interface PackIndexFile {
  lastUsed: Record<string, number>
  jobs: JobRecord[]
}

type Fetcher = (workDir: string, job: JobRecord, signal: AbortSignal) => Promise<string>

interface PendingJob {
  job: JobRecord
  run: () => Promise<void>
}

export const PACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

const versionKeys = new WeakMap<PackManifest, string>()

export function versionKeyOf(manifest: PackManifest): string {
  let key = versionKeys.get(manifest)
  if (key === undefined) {
    key = packVersionKey(manifest.title, manifest.authors)
    versionKeys.set(manifest, key)
  }
  return key
}

/** Newest version first. */
function byVersionDate(a: PackManifest, b: PackManifest): number {
  return packVersionDate(b) - packVersionDate(a) || b.createdAt - a.createdAt
}

/** Every room can see the packs from GameBanana and links, and the uploads that the uploader made public. */
function isListed(manifest: PackManifest): boolean {
  return manifest.source.kind !== 'upload' || Boolean(manifest.source.public)
}

/** When the same files come again from a different source, the pack keeps the most open source. */
function sourceRank(source: PackSourceInfo): number {
  if (source.kind === 'gamebanana') return 3
  if (source.kind === 'url') return 2
  return source.public ? 1 : 0
}

/** The path of a pack folder below the download or upload root, as the player has it in `packs_voice`. */
function packFolder(root: string, dir: string): string {
  const parts = path
    .relative(root, dir)
    .split(path.sep)
    .filter((part) => part && part !== '.')
  const inner = parts.filter((part) => !part.endsWith('_extracted'))
  if (inner.length > 0) return inner.join('/')
  // The pack files were at the top of an uploaded archive: players extract it to a folder with its name.
  const archive = parts[parts.length - 1]
  return archive ? archive.slice(0, -'_extracted'.length).replace(/\.[^.]+$/, '') : ''
}

export function toSummary(manifest: PackManifest): PackSummary {
  return {
    id: manifest.id,
    title: manifest.title,
    subtitle: manifest.subtitle,
    authors: manifest.authors,
    iconUrl: manifest.iconUrl,
    lineCount: manifest.lines.length,
    characterCount: manifest.characters.length,
    duration: manifest.duration,
    videoStatus: manifest.videoStatus,
    videoProgress: manifest.videoProgress,
    source: manifest.source,
    manifestUrl: `/api/packs/${encodeURIComponent(manifest.id)}`,
    createdAt: manifest.createdAt,
    builtAt: manifest.builtAt ?? null,
    versionKey: versionKeyOf(manifest),
  }
}

function publicMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Never leak server paths to the players.
  return message.replace(/[A-Za-z]:\\[^\s"']+|\/(?:data|tmp|app|Volume\d)[^\s"']*/g, '…').slice(0, 300)
}

/**
 * Events:
 * - `job` (JobView): a download / processing job changed.
 * - `pack` (PackManifest): a manifest changed (for example, the video became ready).
 * - `video` (packId, progress): video conversion progress, throttled.
 */
export class PackService extends EventEmitter {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly manifests = new Map<string, PackManifest>()
  private readonly lastUsed = new Map<string, number>()
  private readonly videoQueue: string[] = []
  private videoBusy = false
  private runningJobs = 0
  private readonly pendingJobs: PendingJob[] = []
  private readonly aborts = new WeakMap<JobRecord, AbortController>()
  private saveTimer: NodeJS.Timeout | null = null
  private readonly packsDir: string
  private readonly tmpDir: string
  private readonly indexFile: string
  isInUse: (packId: string) => boolean = () => false

  constructor(
    private readonly config: AppConfig,
    private readonly media: Media,
    private readonly gamebanana: GameBananaClient,
    private readonly log: FastifyBaseLogger,
  ) {
    super()
    this.packsDir = path.join(config.dataDir, 'media', 'packs')
    this.tmpDir = path.join(config.dataDir, 'tmp')
    this.indexFile = path.join(config.dataDir, 'packs-index.json')
  }

  async load(): Promise<void> {
    await ensureDir(this.packsDir)
    await this.removeTemp(this.tmpDir)
    await ensureDir(this.tmpDir)
    const index = await readJson<PackIndexFile>(this.indexFile)
    for (const [id, at] of Object.entries(index?.lastUsed ?? {})) this.lastUsed.set(id, at)
    for (const entry of await fs.readdir(this.packsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.packsDir, entry.name)
      const manifest = await readJson<PackManifest>(path.join(dir, MANIFEST_FILE))
      if (!manifest) {
        await removeDir(dir)
        continue
      }
      if (manifest.videoStatus === 'processing' || manifest.videoStatus === 'pending') {
        manifest.videoStatus = 'pending'
        manifest.videoProgress = 0
        this.videoQueue.push(manifest.id)
      }
      this.manifests.set(manifest.id, manifest)
    }
    for (const job of index?.jobs ?? []) {
      if (job.stage === 'ready' && job.packIds.every((id) => this.manifests.has(id))) this.jobs.set(job.key, job)
    }
    this.log.info({ packs: this.manifests.size }, 'pack cache loaded')
    void this.pumpVideo()
  }

  manifest(packId: string): PackManifest | null {
    return this.manifests.get(packId) ?? null
  }

  summary(packId: string): PackSummary | null {
    const manifest = this.manifests.get(packId)
    return manifest ? toSummary(manifest) : null
  }

  job(key: string | null): JobView | null {
    if (!key) return null
    const job = this.jobs.get(key)
    return job ? this.toView(job) : null
  }

  /**
   * The packs that every room can see, most recently used first. All versions of a pack come together,
   * newest version first, and count as one entry for the limit.
   */
  listRecent(limit = 60): PackSummary[] {
    const used = (manifest: PackManifest) => this.lastUsed.get(manifest.id) ?? manifest.createdAt
    const groups = new Map<string, PackManifest[]>()
    for (const manifest of [...this.manifests.values()].filter(isListed).sort((a, b) => used(b) - used(a))) {
      const key = versionKeyOf(manifest)
      const group = groups.get(key)
      if (group) group.push(manifest)
      else if (groups.size < limit) groups.set(key, [manifest])
    }
    return [...groups.values()].flatMap((group) => group.sort(byVersionDate).map(toSummary))
  }

  /**
   * All versions of a pack that the room can see: the pack itself and the listed packs with the same title
   * and authors. Newest first. Empty when the pack has no other version.
   */
  versions(packId: string): PackSummary[] {
    const current = this.manifests.get(packId)
    if (!current) return []
    const key = versionKeyOf(current)
    const group = [...this.manifests.values()].filter(
      (manifest) => manifest.id === packId || (isListed(manifest) && versionKeyOf(manifest) === key),
    )
    return group.length > 1 ? group.sort(byVersionDate).map(toSummary) : []
  }

  /** A prepared pack with exactly the same files, if there is one. */
  private findByHash(hash: string): PackManifest | null {
    for (const manifest of this.manifests.values()) if (manifest.contentHash === hash) return manifest
    return null
  }

  /** The same files came again. Use the existing pack, with the most open source, and retry a failed video. */
  private async reuse(manifest: PackManifest, source: PackSourceInfo): Promise<void> {
    let changed = false
    if (sourceRank(source) > sourceRank(manifest.source)) {
      manifest.source = source
      changed = true
    }
    if (manifest.videoStatus === 'error') {
      manifest.videoStatus = 'pending'
      manifest.videoProgress = 0
      delete manifest.videoError
      if (!this.videoQueue.includes(manifest.id)) this.videoQueue.push(manifest.id)
      changed = true
    }
    this.touch(manifest.id)
    if (changed) {
      await this.writeManifest(manifest)
      this.emit('pack', manifest)
    }
  }

  packDir(packId: string): string {
    return path.join(this.packsDir, packId)
  }

  touch(packId: string): void {
    this.lastUsed.set(packId, Date.now())
    this.scheduleSave()
  }

  prioritizeVideo(packId: string): void {
    const index = this.videoQueue.indexOf(packId)
    if (index > 0) {
      this.videoQueue.splice(index, 1)
      this.videoQueue.unshift(packId)
    }
  }

  requestGameBanana(info: {
    modId: number
    fileId: number
    modName: string
    fileName: string
    size: number
    pageUrl?: string
    images?: string[]
    description?: string
  }): JobView {
    const source: PackSourceInfo = {
      kind: 'gamebanana',
      name: info.modName,
      modId: info.modId,
      fileId: info.fileId,
      pageUrl: info.pageUrl ?? `https://gamebanana.com/mods/${info.modId}`,
    }
    const extras: Partial<JobView> = { pageUrl: source.pageUrl as string }
    if (info.images?.length) extras.images = info.images.slice(0, 4)
    if (info.description) extras.description = info.description.slice(0, 600)
    return this.startJob(`gb:${info.fileId}`, info.modName, source, `gb${info.fileId}`, extras, async (workDir, job, signal) => {
      return this.downloadAndExtract(job, workDir, this.gamebanana.downloadUrl(info.fileId), GAMEBANANA_HOSTS, info.size, signal)
    })
  }

  requestUrl(url: string, uploader: string): JobView {
    const parsed = new URL(url)
    const label = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname)
    const source: PackSourceInfo = { kind: 'url', name: label, url, uploader, public: true }
    const hash = shortHash(url)
    return this.startJob(`url:${hash}`, label, source, `url${hash}`, {}, async (workDir, job, signal) => {
      return this.downloadAndExtract(job, workDir, url, this.config.importHosts, 0, signal)
    })
  }

  requestUpload(info: { uploadId: string; dir: string; label: string; uploader: string; public: boolean }): JobView {
    const source: PackSourceInfo = {
      kind: 'upload',
      name: info.label,
      uploader: info.uploader,
      public: info.public,
    }
    return this.startJob(`up:${info.uploadId}`, info.label, source, `up${info.uploadId}`, {}, async (workDir, job, signal) => {
      const root = path.join(workDir, 'upload')
      await fs.rename(info.dir, root)
      const archives = await findArchives(root)
      for (const [index, archive] of archives.entries()) {
        this.update(job, { stage: 'extracting', progress: index / Math.max(1, archives.length) })
        await this.extract(archive, `${archive}_extracted`, signal)
        await fs.rm(archive, { force: true })
      }
      return root
    })
  }

  /**
   * Stops a job that is waiting or running and forgets it. A job that is ready is not changed.
   * Returns true when the job was stopped or removed.
   */
  cancel(key: string): boolean {
    const job = this.jobs.get(key)
    if (!job || job.stage === 'ready') return false
    this.jobs.delete(key)
    const index = this.pendingJobs.findIndex((entry) => entry.job === job)
    if (index >= 0) this.pendingJobs.splice(index, 1)
    this.aborts.get(job)?.abort()
    this.log.info({ job: key }, 'pack job cancelled')
    return true
  }

  private toView(job: JobRecord): JobView {
    const view: JobView = {
      key: job.key,
      label: job.label,
      stage: job.stage,
      progress: job.progress,
      packIds: job.packIds,
    }
    if (job.message) view.message = job.message
    if (job.pageUrl) view.pageUrl = job.pageUrl
    if (job.images?.length) view.images = job.images
    if (job.description) view.description = job.description
    return view
  }

  private lastEmit = new Map<string, number>()

  private update(job: JobRecord, patch: Partial<JobRecord>): void {
    const stageChanged = patch.stage !== undefined && patch.stage !== job.stage
    Object.assign(job, patch, { updatedAt: Date.now() })
    // A cancelled job can still run for a moment. It must not send updates for a new job with the same key.
    if (this.jobs.get(job.key) !== job) return
    const now = Date.now()
    if (stageChanged || now - (this.lastEmit.get(job.key) ?? 0) > 400) {
      this.lastEmit.set(job.key, now)
      this.emit('job', this.toView(job))
    }
  }

  private startJob(
    key: string,
    label: string,
    source: PackSourceInfo,
    prefix: string,
    extras: Partial<JobView>,
    fetcher: Fetcher,
  ): JobView {
    const existing = this.jobs.get(key)
    if (existing && existing.stage !== 'error') {
      if (existing.stage !== 'ready' || existing.packIds.every((id) => this.manifests.has(id))) {
        for (const id of existing.packIds) this.touch(id)
        return this.toView(existing)
      }
    }
    const job: JobRecord = {
      ...extras,
      key,
      label,
      stage: 'queued',
      progress: 0,
      packIds: [],
      source,
      updatedAt: Date.now(),
    }
    const controller = new AbortController()
    this.aborts.set(job, controller)
    this.jobs.set(key, job)
    this.emit('job', this.toView(job))
    this.pendingJobs.push({ job, run: () => this.runJob(job, prefix, fetcher, controller.signal) })
    void this.pumpJobs()
    return this.toView(job)
  }

  private async pumpJobs(): Promise<void> {
    while (this.runningJobs < 2 && this.pendingJobs.length > 0) {
      const next = this.pendingJobs.shift()
      if (!next) break
      this.runningJobs += 1
      void next
        .run()
        .catch((error: unknown) => this.log.error({ err: error }, 'pack job crashed'))
        .finally(() => {
          this.runningJobs -= 1
          void this.pumpJobs()
        })
    }
  }

  /** Removes a temporary folder. A failure is only a warning: it must never stop the server. */
  private async removeTemp(dir: string): Promise<void> {
    try {
      await removeDir(dir)
    } catch (error) {
      this.log.warn({ err: error, dir }, 'temporary folder cleanup failed')
    }
  }

  private async extract(archive: string, destination: string, signal?: AbortSignal): Promise<void> {
    await ensureDir(destination)
    try {
      await this.media.extractArchive(archive, destination, signal)
    } catch (error) {
      signal?.throwIfAborted()
      await makeTreeWritable(destination)
      const files = await walkFiles(destination)
      if (files.length === 0) {
        throw new Error('The file is not a zip, 7z or rar archive, or the archive is damaged', { cause: error })
      }
      this.log.warn({ err: error }, 'archive extracted with warnings')
    }
    // Archives can contain read-only folders. They block the moves and the cleanup later.
    await makeTreeWritable(destination)
  }

  private async downloadAndExtract(
    job: JobRecord,
    workDir: string,
    url: string,
    hosts: string[],
    expectedSize: number,
    signal: AbortSignal,
  ): Promise<string> {
    this.update(job, { stage: 'downloading', progress: 0 })
    const archive = path.join(workDir, 'download.bin')
    await downloadToFile(url, archive, {
      allowedHosts: hosts,
      maxBytes: this.config.downloadMaxBytes,
      userAgent: this.config.userAgent,
      expectedSize,
      signal,
      onProgress: (received, total) => this.update(job, { progress: total > 0 ? received / total : 0 }),
    })
    signal.throwIfAborted()
    this.update(job, { stage: 'extracting', progress: 0 })
    const root = path.join(workDir, 'extracted')
    await this.extract(archive, root, signal)
    await fs.rm(archive, { force: true })
    return root
  }

  private async runJob(job: JobRecord, prefix: string, fetcher: Fetcher, signal: AbortSignal): Promise<void> {
    const workDir = path.join(this.tmpDir, `job-${randomId(6)}`)
    const created: string[] = []
    try {
      await ensureDir(workDir)
      signal.throwIfAborted()
      this.update(job, { stage: 'resolving', progress: 0 })
      const root = await fetcher(workDir, job, signal)
      signal.throwIfAborted()
      if ((await dirSize(root)) > this.config.downloadMaxBytes * 4) throw new Error('The extracted pack is too large')
      this.update(job, { stage: 'processing', progress: 0 })
      let dirs = await findPackDirs(root)
      if (dirs.length === 0) {
        for (const archive of await findArchives(root)) await this.extract(archive, `${archive}_extracted`, signal)
        dirs = await findPackDirs(root)
      }
      if (dirs.length === 0) {
        throw new Error('No Choicer Voicer pack was found. A pack folder contains _pack_info.ini and dub_video.ogv.')
      }
      const ids: string[] = []
      let firstError: unknown = null
      for (const [index, dir] of dirs.entries()) {
        signal.throwIfAborted()
        const packId = `${prefix}-${index + 1}`
        if (this.manifests.has(packId)) {
          if (!ids.includes(packId)) ids.push(packId)
          continue
        }
        try {
          const fingerprint = await fingerprintPack(dir)
          signal.throwIfAborted()
          const same = this.findByHash(fingerprint.hash)
          if (same) {
            await this.reuse(same, job.source)
            if (same.lines.some((line) => !line.file)) {
              // Packs from before the line file names were kept. The same files give the same line order.
              const raw = await readPack(dir)
              if (raw.lines.length === same.lines.length) {
                same.lines.forEach((line, lineIndex) => {
                  line.file = raw.lines[lineIndex]?.name
                })
                same.folder ??= packFolder(root, dir)
                await this.writeManifest(same)
              }
            }
            if (!ids.includes(same.id)) ids.push(same.id)
            this.log.info({ packId: same.id, job: job.key }, 'the same pack is already on the server')
            continue
          }
          const raw = await readPack(dir)
          const outDir = this.packDir(packId)
          await removeDir(outDir)
          const manifest = await processPackPhaseA({
            raw,
            packId,
            source: job.source,
            outDir,
            media: this.media,
            fingerprint,
            folder: packFolder(root, dir),
            onProgress: (fraction) => this.update(job, { progress: (index + fraction) / dirs.length }),
          })
          signal.throwIfAborted()
          this.manifests.set(packId, manifest)
          created.push(packId)
          this.touch(packId)
          this.videoQueue.push(packId)
          ids.push(packId)
          // Rooms that use another version of this pack learn about the new version.
          this.emit('pack', manifest)
          if (raw.warnings.length > 0) this.log.info({ packId, warnings: raw.warnings.slice(0, 10) }, 'pack warnings')
        } catch (error) {
          await this.removeTemp(this.packDir(packId))
          if (signal.aborted) throw error
          firstError ??= error
          this.log.warn({ err: error, packId }, 'pack processing failed')
        }
      }
      signal.throwIfAborted()
      if (ids.length === 0) throw firstError ?? new Error('No pack could be processed')
      this.update(job, { stage: 'ready', progress: 1, packIds: ids })
      void this.pumpVideo()
    } catch (error) {
      if (signal.aborted) {
        // Nobody wants the packs of a cancelled job, so do not keep them or convert their video.
        for (const packId of created) {
          if (this.isInUse(packId)) continue
          this.manifests.delete(packId)
          this.lastUsed.delete(packId)
          const queued = this.videoQueue.indexOf(packId)
          if (queued >= 0) this.videoQueue.splice(queued, 1)
          await this.removeTemp(this.packDir(packId))
        }
        this.log.info({ job: job.key }, 'pack job stopped')
      } else {
        this.log.warn({ err: error, job: job.key }, 'pack job failed')
        this.update(job, { stage: 'error', message: publicMessage(error) })
      }
    } finally {
      await this.removeTemp(workDir)
      this.scheduleSave()
      void this.evict().catch((error: unknown) => this.log.warn({ err: error }, 'pack cache eviction failed'))
    }
  }

  private async writeManifest(manifest: PackManifest): Promise<void> {
    if (await exists(this.packDir(manifest.id))) {
      await writeJsonAtomic(path.join(this.packDir(manifest.id), MANIFEST_FILE), manifest)
    }
  }

  private async pumpVideo(): Promise<void> {
    if (this.videoBusy) return
    this.videoBusy = true
    try {
      while (this.videoQueue.length > 0) {
        const packId = this.videoQueue.shift() as string
        const manifest = this.manifests.get(packId)
        if (!manifest || manifest.videoStatus === 'ready') continue
        manifest.videoStatus = 'processing'
        manifest.videoProgress = 0
        await this.writeManifest(manifest)
        this.emit('pack', manifest)
        let lastEmit = 0
        try {
          const updated = await processPackPhaseB({
            manifest,
            outDir: this.packDir(packId),
            media: this.media,
            onProgress: (fraction) => {
              manifest.videoProgress = fraction
              const now = Date.now()
              if (now - lastEmit > 1000) {
                lastEmit = now
                this.emit('video', packId, fraction)
              }
            },
          })
          this.manifests.set(packId, updated)
          await this.writeManifest(updated)
          this.emit('pack', updated)
        } catch (error) {
          this.log.warn({ err: error, packId }, 'video conversion failed')
          manifest.videoStatus = 'error'
          manifest.videoError = publicMessage(error)
          await this.writeManifest(manifest)
          this.emit('pack', manifest)
        }
      }
    } catch (error) {
      this.log.error({ err: error }, 'video queue failed')
    } finally {
      this.videoBusy = false
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const index: PackIndexFile = {
        lastUsed: Object.fromEntries(this.lastUsed),
        jobs: [...this.jobs.values()].filter((job) => job.stage === 'ready'),
      }
      void writeJsonAtomic(this.indexFile, index).catch((error) => this.log.warn({ err: error }, 'pack index save failed'))
    }, 2000)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await writeJsonAtomic(this.indexFile, {
      lastUsed: Object.fromEntries(this.lastUsed),
      jobs: [...this.jobs.values()].filter((job) => job.stage === 'ready'),
    })
  }

  /** Removes the least recently used packs when the cache is larger than the limit. */
  async evict(): Promise<void> {
    const sizes: { id: string; size: number; used: number }[] = []
    for (const manifest of this.manifests.values()) {
      sizes.push({
        id: manifest.id,
        size: await dirSize(this.packDir(manifest.id)),
        used: this.lastUsed.get(manifest.id) ?? manifest.createdAt,
      })
    }
    let total = sizes.reduce((sum, entry) => sum + entry.size, 0)
    if (total <= this.config.packCacheMaxBytes) return
    sizes.sort((a, b) => a.used - b.used)
    for (const entry of sizes) {
      if (total <= this.config.packCacheMaxBytes) break
      const manifest = this.manifests.get(entry.id)
      if (!manifest || this.isInUse(entry.id) || manifest.videoStatus === 'processing') continue
      await removeDir(this.packDir(entry.id))
      this.manifests.delete(entry.id)
      this.lastUsed.delete(entry.id)
      for (const [key, job] of this.jobs) if (job.packIds.includes(entry.id)) this.jobs.delete(key)
      total -= entry.size
      this.log.info({ packId: entry.id }, 'evicted pack from cache')
    }
    this.scheduleSave()
  }
}
