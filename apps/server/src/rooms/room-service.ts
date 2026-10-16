import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import {
  DEFAULT_ROOM_SETTINGS,
  MAX_KEYWORDS,
  MAX_PLAYERS,
  MAX_QUEUE,
  MAX_SUGGESTIONS,
  PLAYBACK_LEAD_MS,
  PLAYER_COLORS,
  SCORE_SAMPLE_RATE,
  buildCues,
  loudnessEnvelope,
  matchEnvelopes,
  parseKeywords,
  playbackPosition,
  unfinishedPlayers,
  type AssetStatus,
  type DubView,
  type GameMode,
  type JobView,
  type PackManifest,
  type PackPick,
  type PackRequest,
  type PlaybackState,
  type ProgressView,
  type QueueEntryView,
  type RandomPickView,
  type RecordingView,
  type RoomInfoResponse,
  type RoomKeyword,
  type RoomPhase,
  type RoomSettings,
  type RoomView,
  type RoundView,
  type SessionResponse,
  type SourceRequest,
} from '@mcv/shared'
import type { CatalogService } from '../catalog/catalog-service.js'
import { parseGameBananaModUrl } from '../catalog/gamebanana.js'
import type { AppConfig } from '../config.js'
import { versionKeyOf, type PackService } from '../packs/pack-service.js'
import { isHostAllowed } from '../util/download.js'
import { ensureDir, readJson, removeDir, writeJsonAtomic } from '../util/fsx.js'
import { createRoomCode, createToken, hashToken, randomId, shuffle } from '../util/ids.js'
import type { Media } from '../util/media.js'
import { pickRandomPack } from './random-pack.js'

/** An error whose message is safe to show to the player. */
export class RoomError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

interface PlayerRecord {
  id: string
  name: string
  color: string
  tokenHash: string
  joinedAt: number
  spectator: boolean
}

interface QueueRecord extends PackPick {
  jobKey: string | null
  packIds: string[]
  error: string | null
}

interface RoomRecord {
  id: string
  code: string
  createdAt: number
  updatedAt: number
  hostId: string
  phase: RoomPhase
  players: PlayerRecord[]
  settings: RoomSettings
  packId: string | null
  packChoices: string[]
  jobKey: string | null
  suggestions: PackPick[]
  queue: QueueRecord[]
  keywords: RoomKeyword[]
  /** GameBanana mods that this room played or picked at random, oldest first. */
  playedModIds: number[]
  randomPick: RandomPickView | null
  cast: Record<string, string>
  round: RoundView | null
  playback: PlaybackState | null
  votes: Record<string, string>
  emptySince: number | null
}

interface RoomsFile {
  rooms: RoomRecord[]
}

const HOST_GRACE_MS = 60_000
const MAX_PLAYED_MODS = 500
const RANDOM_AUTO_RETRIES = 3

const RANDOM_ERRORS = {
  'empty-catalog': 'The list from GameBanana is not loaded yet. Try again in a minute.',
  'no-matches': 'No pack matches these keywords. Add other keywords.',
  'no-usable-file': 'The server did not find a pack that it can download. Try again.',
} as const

function requestKey(request: PackRequest): string {
  if (request.kind === 'gamebanana') return `gb:${request.fileId}`
  if (request.kind === 'url') return `url:${request.url}`
  return `pack:${request.packId}`
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'video/webm': 'webm',
  'video/mp4': 'm4a',
}

function lineLoad(manifest: PackManifest, lineIds: Set<string> | null): Map<string, number> {
  const load = new Map<string, number>()
  for (const line of manifest.lines) {
    if (lineIds && !lineIds.has(line.id)) continue
    load.set(line.id, Math.max(0.5, line.promptDuration) * line.timestamps.length)
  }
  return load
}

/** Gives every character to the player with the least speaking time so far. */
export function autoCast(
  manifest: PackManifest,
  playerIds: string[],
  keep: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  const load = new Map(playerIds.map((id) => [id, 0]))
  const count = new Map(playerIds.map((id) => [id, 0]))
  for (const character of manifest.characters) {
    const kept = keep[character.name]
    if (kept && load.has(kept)) {
      result[character.name] = kept
      load.set(kept, (load.get(kept) ?? 0) + character.seconds)
      count.set(kept, (count.get(kept) ?? 0) + 1)
    }
  }
  for (const character of manifest.characters) {
    if (result[character.name]) continue
    const target = [...load.entries()].sort(
      (a, b) => a[1] - b[1] || (count.get(a[0]) ?? 0) - (count.get(b[0]) ?? 0),
    )[0]
    if (!target) break
    result[character.name] = target[0]
    load.set(target[0], target[1] + Math.max(character.seconds, 0.5))
    count.set(target[0], (count.get(target[0]) ?? 0) + 1)
  }
  return result
}

export function buildDubs(
  manifest: PackManifest,
  mode: GameMode,
  players: { id: string; name: string }[],
  cast: Record<string, string>,
): DubView[] {
  const empty = (id: string, name: string, ownerId: string | null): DubView => ({
    id,
    name,
    ownerId,
    assignments: {},
    recordings: {},
    export: { status: 'idle', progress: 0 },
  })
  if (mode === 'versus') {
    return players.map((player) => {
      const dub = empty(randomId(6), player.name, player.id)
      for (const line of manifest.lines) dub.assignments[line.id] = player.id
      return dub
    })
  }
  const dub = empty(randomId(6), mode === 'cast' ? 'Ensemble' : 'Chaos', null)
  if (mode === 'cast') {
    for (const line of manifest.lines) {
      const character = line.characters.find((name) => cast[name])
      const playerId = character ? cast[character] : players[0]?.id
      if (playerId) dub.assignments[line.id] = playerId
    }
    return [dub]
  }
  const load = new Map(players.map((player) => [player.id, 0]))
  const weights = lineLoad(manifest, null)
  for (const line of shuffle(manifest.lines)) {
    const target = [...load.entries()].sort((a, b) => a[1] - b[1])[0]
    if (!target) break
    dub.assignments[line.id] = target[0]
    load.set(target[0], target[1] + (weights.get(line.id) ?? 1))
  }
  return [dub]
}

/**
 * Events: `state` (code), `progress` (code, playerId, progress), `assets` (code, playerId, assets),
 * `job` (code, job), `video` (code, packId, progress), `kicked` (code, playerId), `closed` (code).
 */
export class RoomService extends EventEmitter {
  private readonly rooms = new Map<string, RoomRecord>()
  private readonly tokens = new Map<string, { code: string; playerId: string }>()
  private readonly connections = new Map<string, number>()
  private readonly assets = new Map<string, AssetStatus>()
  private readonly progress = new Map<string, ProgressView>()
  private readonly hostTimers = new Map<string, NodeJS.Timeout>()
  private readonly promptEnvelopes = new Map<string, number[]>()
  /** GameBanana mods without an archive file within the download limit, or whose archive has no pack. */
  private readonly unusableMods = new Set<number>()
  /** Room code -> automatic re-rolls after failed random picks since the host last pressed the button. */
  private readonly randomRetries = new Map<string, number>()
  private saveTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private exportChain: Promise<void> = Promise.resolve()
  private readonly file: string
  private readonly roomsDir: string
  private readonly mediaDir: string

  constructor(
    private readonly config: AppConfig,
    private readonly packs: PackService,
    private readonly catalog: CatalogService,
    private readonly media: Media,
    private readonly log: FastifyBaseLogger,
  ) {
    super()
    this.file = path.join(config.dataDir, 'rooms.json')
    this.mediaDir = path.join(config.dataDir, 'media')
    this.roomsDir = path.join(this.mediaDir, 'rooms')
    packs.isInUse = (packId) => this.isPackInUse(packId)
    packs.on('job', (job: JobView) => this.onJob(job))
    packs.on('pack', (manifest: PackManifest) => {
      const key = versionKeyOf(manifest)
      for (const room of this.rooms.values()) {
        const current = room.packId ? this.packs.manifest(room.packId) : null
        if (this.roomUsesPack(room, manifest.id) || (current && versionKeyOf(current) === key)) this.emit('state', room.code)
      }
    })
    packs.on('video', (packId: string, fraction: number) => {
      for (const room of this.rooms.values()) {
        if (this.roomUsesPack(room, packId)) this.emit('video', room.code, packId, fraction)
      }
    })
  }

  async load(): Promise<void> {
    await ensureDir(this.roomsDir)
    const stored = await readJson<RoomsFile>(this.file)
    const now = Date.now()
    for (const room of stored?.rooms ?? []) {
      room.emptySince = now
      room.settings = { ...DEFAULT_ROOM_SETTINGS, ...room.settings }
      room.suggestions ??= []
      room.queue ??= []
      room.keywords ??= []
      room.playedModIds ??= []
      room.randomPick = room.randomPick?.searching ? null : (room.randomPick ?? null)
      if (room.round) room.round.finished ??= {}
      if (room.playback?.status === 'playing') {
        room.playback = { ...room.playback, status: 'paused', position: playbackPosition(room.playback, now), startedAt: now }
      }
      for (const dub of room.round?.dubs ?? []) {
        if (dub.export.status === 'rendering') dub.export = { status: 'idle', progress: 0 }
      }
      this.rooms.set(room.code, room)
      for (const player of room.players) this.tokens.set(player.tokenHash, { code: room.code, playerId: player.id })
    }
    this.sweepTimer = setInterval(() => void this.sweep(), 10 * 60_000)
    this.log.info({ rooms: this.rooms.size }, 'rooms loaded')
    // Jobs that were running before the restart are gone. Start them again for the queued packs.
    for (const room of this.rooms.values()) {
      for (const entry of room.queue) {
        if (entry.packIds.length > 0 || entry.error || this.packs.job(entry.jobKey)) continue
        void this.prepareEntry(room, entry).then(() => this.changed(room))
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    for (const timer of this.hostTimers.values()) clearTimeout(timer)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    await this.saveNow()
  }

  // ---------------------------------------------------------------- persistence

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveNow()
    }, 2000)
  }

  private async saveNow(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, { rooms: [...this.rooms.values()] } satisfies RoomsFile)
    } catch (error) {
      this.log.warn({ err: error }, 'rooms save failed')
    }
  }

  private changed(room: RoomRecord): void {
    room.updatedAt = Date.now()
    this.scheduleSave()
    this.emit('state', room.code)
  }

  // ---------------------------------------------------------------- helpers

  private get(code: string): RoomRecord {
    const room = this.rooms.get(code.toUpperCase())
    if (!room) throw new RoomError('This room does not exist or has expired', 404)
    return room
  }

  private requireHost(room: RoomRecord, actorId: string): void {
    if (room.hostId !== actorId) throw new RoomError('Only the host can do that', 403)
  }

  private requirePhase(room: RoomRecord, ...phases: RoomPhase[]): void {
    if (!phases.includes(room.phase)) throw new RoomError('That is not possible at this stage of the game', 409)
  }

  isConnected(playerId: string): boolean {
    return (this.connections.get(playerId) ?? 0) > 0
  }

  private activePlayers(room: RoomRecord): PlayerRecord[] {
    return room.players.filter((player) => !player.spectator && this.isConnected(player.id))
  }

  private roomUsesPack(room: RoomRecord, packId: string): boolean {
    return (
      room.packId === packId ||
      room.packChoices.includes(packId) ||
      room.round?.packId === packId ||
      room.queue.some((entry) => entry.packIds.includes(packId))
    )
  }

  isPackInUse(packId: string): boolean {
    for (const room of this.rooms.values()) if (this.roomUsesPack(room, packId)) return true
    return false
  }

  roomDir(room: { id: string }): string {
    return path.join(this.roomsDir, room.id)
  }

  /** Converts a `/media/...` URL to a file path inside the media folder. */
  mediaPath(url: string): string | null {
    if (!url.startsWith('/media/')) return null
    const relative = decodeURIComponent(url.slice('/media/'.length).split('?')[0] ?? '')
    const full = path.resolve(this.mediaDir, relative)
    return full.startsWith(path.resolve(this.mediaDir) + path.sep) ? full : null
  }

  private newPlayer(room: RoomRecord | null, name: string, spectator: boolean): { player: PlayerRecord; token: string } {
    const used = new Set(room?.players.map((player) => player.color) ?? [])
    const color =
      PLAYER_COLORS.find((value) => !used.has(value)) ??
      PLAYER_COLORS[(room?.players.length ?? 0) % PLAYER_COLORS.length] ??
      '#adb5bd'
    const token = createToken()
    return {
      token,
      player: { id: randomId(8), name, color, tokenHash: hashToken(token), joinedAt: Date.now(), spectator },
    }
  }

  // ---------------------------------------------------------------- sessions

  async createRoom(name: string): Promise<SessionResponse> {
    if (this.rooms.size >= this.config.maxRooms) await this.sweep(true)
    if (this.rooms.size >= this.config.maxRooms) throw new RoomError('The server is full. Try again later.', 503)
    let code = createRoomCode()
    while (this.rooms.has(code)) code = createRoomCode()
    const { player, token } = this.newPlayer(null, name, false)
    const now = Date.now()
    const room: RoomRecord = {
      id: randomId(12),
      code,
      createdAt: now,
      updatedAt: now,
      hostId: player.id,
      phase: 'lobby',
      players: [player],
      settings: { ...DEFAULT_ROOM_SETTINGS },
      packId: null,
      packChoices: [],
      jobKey: null,
      suggestions: [],
      queue: [],
      keywords: [],
      playedModIds: [],
      randomPick: null,
      cast: {},
      round: null,
      playback: null,
      votes: {},
      emptySince: now,
    }
    this.rooms.set(code, room)
    this.tokens.set(player.tokenHash, { code, playerId: player.id })
    this.changed(room)
    return { code, playerId: player.id, token }
  }

  joinRoom(code: string, name: string): SessionResponse {
    const room = this.get(code)
    const existing = room.players.find((player) => player.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      if (this.isConnected(existing.id)) throw new RoomError('Somebody in this room already uses that name', 409)
      // Give the seat back to a returning player.
      this.tokens.delete(existing.tokenHash)
      const token = createToken()
      existing.tokenHash = hashToken(token)
      this.tokens.set(existing.tokenHash, { code: room.code, playerId: existing.id })
      this.changed(room)
      return { code: room.code, playerId: existing.id, token }
    }
    if (room.players.length >= MAX_PLAYERS) throw new RoomError('This room is full', 409)
    const { player, token } = this.newPlayer(room, name, room.phase !== 'lobby')
    room.players.push(player)
    this.tokens.set(player.tokenHash, { code: room.code, playerId: player.id })
    this.changed(room)
    return { code: room.code, playerId: player.id, token }
  }

  authenticate(code: string, token: string): string | null {
    const entry = this.tokens.get(hashToken(token))
    if (!entry || entry.code !== code.toUpperCase()) return null
    return this.rooms.has(entry.code) ? entry.playerId : null
  }

  info(code: string): RoomInfoResponse {
    const room = this.get(code)
    const host = room.players.find((player) => player.id === room.hostId)
    return {
      code: room.code,
      phase: room.phase,
      playerCount: room.players.length,
      hostName: host?.name ?? '',
      packTitle: room.packId ? (this.packs.manifest(room.packId)?.title ?? null) : null,
    }
  }

  playerName(code: string, playerId: string): string {
    return this.get(code).players.find((player) => player.id === playerId)?.name ?? 'Player'
  }

  connect(code: string, playerId: string): void {
    const room = this.rooms.get(code)
    if (!room) return
    this.connections.set(playerId, (this.connections.get(playerId) ?? 0) + 1)
    room.emptySince = null
    if (room.hostId === playerId) {
      const timer = this.hostTimers.get(code)
      if (timer) clearTimeout(timer)
      this.hostTimers.delete(code)
    }
    this.changed(room)
  }

  disconnect(code: string, playerId: string): void {
    const count = Math.max(0, (this.connections.get(playerId) ?? 0) - 1)
    if (count === 0) this.connections.delete(playerId)
    else this.connections.set(playerId, count)
    const room = this.rooms.get(code)
    if (!room) return
    if (count === 0) {
      this.progress.delete(playerId)
      if (room.hostId === playerId && !this.hostTimers.has(code)) {
        this.hostTimers.set(
          code,
          setTimeout(() => {
            this.hostTimers.delete(code)
            this.migrateHost(code)
          }, HOST_GRACE_MS),
        )
      }
      if (!room.players.some((player) => this.isConnected(player.id))) room.emptySince = Date.now()
    }
    this.changed(room)
  }

  private migrateHost(code: string): void {
    const room = this.rooms.get(code)
    if (!room || this.isConnected(room.hostId)) return
    const next = room.players.find((player) => player.id !== room.hostId && this.isConnected(player.id))
    if (next) {
      room.hostId = next.id
      this.changed(room)
    }
  }

  // ---------------------------------------------------------------- view

  view(code: string, viewerId: string): RoomView {
    const room = this.get(code)
    const votes: Record<string, string> = {}
    for (const [voter, dubId] of Object.entries(room.votes)) {
      votes[voter] = room.phase === 'voting' && voter !== viewerId ? '' : dubId
    }
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        connected: this.isConnected(player.id),
        spectator: player.spectator,
        assets: this.assets.get(player.id) ?? null,
        progress: this.progress.get(player.id) ?? null,
      })),
      settings: room.settings,
      pack: room.packId ? this.packs.summary(room.packId) : null,
      packChoices: room.packChoices.map((id) => this.packs.summary(id)).filter((value) => value !== null),
      packVersions: room.packId ? this.packs.versions(room.packId) : [],
      job: this.packs.job(room.jobKey),
      suggestions: room.suggestions,
      queue: room.queue.map(
        (entry): QueueEntryView => ({
          id: entry.id,
          request: entry.request,
          title: entry.title,
          pageUrl: entry.pageUrl,
          imageUrl: entry.imageUrl,
          by: entry.by,
          at: entry.at,
          job: this.packs.job(entry.jobKey),
          pack: entry.packIds[0] ? this.packs.summary(entry.packIds[0]) : null,
          error: entry.error,
        }),
      ),
      keywords: room.keywords,
      randomPick: room.randomPick,
      cast: room.cast,
      round: room.round,
      playback: room.playback,
      votes,
      serverNow: Date.now(),
    }
  }

  // ---------------------------------------------------------------- lobby

  updateSettings(code: string, actorId: string, patch: Partial<RoomSettings>): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    const roundKeys = ['mode', 'showSceneWhileRecording', 'allowGoingBack'] as const
    if (roundKeys.some((key) => patch[key] !== undefined && patch[key] !== room.settings[key])) {
      this.requirePhase(room, 'lobby', 'results')
    }
    room.settings = { ...room.settings, ...patch }
    this.changed(room)
  }

  private applyPack(room: RoomRecord, packIds: string[]): void {
    const first = packIds[0]
    if (!first) return
    room.packId = first
    room.packChoices = packIds
    room.cast = {}
    for (const id of packIds) this.packs.touch(id)
    this.packs.prioritizeVideo(first)
  }

  private onJob(job: JobView): void {
    for (const room of this.rooms.values()) {
      let stateChanged = false
      let progress = false
      for (const entry of room.queue) {
        if (entry.jobKey !== job.key) continue
        if (job.stage === 'ready') {
          entry.packIds = job.packIds
          entry.jobKey = null
          stateChanged = true
        } else if (job.stage === 'error') {
          entry.error = job.message ?? 'The pack could not be prepared'
          entry.jobKey = null
          stateChanged = true
        } else {
          progress = true
        }
      }
      if (room.jobKey === job.key) {
        if (job.stage === 'ready') {
          if (room.phase === 'lobby' || room.phase === 'results') this.applyPack(room, job.packIds)
          room.jobKey = null
          stateChanged = true
        } else if (job.stage === 'error') {
          stateChanged = true
          this.retryRandomPick(room)
        } else {
          progress = true
        }
      }
      if (stateChanged) this.changed(room)
      else if (progress) this.emit('job', room.code, job)
    }
  }

  /** Stops a server job when no room and no queue needs it any more. */
  private releaseJob(key: string | null): void {
    if (!key) return
    for (const room of this.rooms.values()) {
      if (room.jobKey === key || room.queue.some((entry) => entry.jobKey === key)) return
    }
    this.packs.cancel(key)
  }

  private setJob(room: RoomRecord, key: string | null): void {
    const previous = room.jobKey
    room.jobKey = key
    if (previous && previous !== key) this.releaseJob(previous)
  }

  private attachJob(room: RoomRecord, job: JobView, randomPick: RandomPickView | null = null): JobView {
    room.randomPick = randomPick
    if (job.stage === 'ready') {
      this.setJob(room, null)
      this.applyPack(room, job.packIds)
    } else {
      this.setJob(room, job.key)
    }
    this.changed(room)
    return job
  }

  /** Checks a pack request and finds its title, page and picture. GameBanana links become GameBanana requests. */
  private async resolvePick(request: SourceRequest): Promise<Pick<PackPick, 'request' | 'title' | 'pageUrl' | 'imageUrl'>> {
    if (request.kind === 'random') throw new RoomError('Choose a pack first')
    if (request.kind === 'pack') {
      const manifest = this.packs.manifest(request.packId)
      if (!manifest) throw new RoomError('That pack is no longer on the server', 404)
      return {
        request: { kind: 'pack', packId: manifest.id },
        title: manifest.title,
        pageUrl: manifest.source.pageUrl ?? null,
        imageUrl: manifest.iconUrl,
      }
    }
    const modId = request.kind === 'gamebanana' ? request.modId : parseGameBananaModUrl(request.url)
    if (modId) {
      const details = await this.catalog.details(modId).catch(() => {
        throw new RoomError('GameBanana did not return that mod')
      })
      const file =
        request.kind === 'gamebanana'
          ? details.files.find((entry) => entry.id === request.fileId)
          : (details.files.find((entry) => entry.isArchive) ?? details.files[0])
      if (!file) {
        throw new RoomError(request.kind === 'gamebanana' ? 'That file does not belong to the mod' : 'That GameBanana mod has no files')
      }
      if (file.size > this.config.downloadMaxBytes) throw new RoomError('That pack is larger than the download limit')
      return {
        request: { kind: 'gamebanana', modId, fileId: file.id },
        title: details.name,
        pageUrl: details.profileUrl,
        imageUrl: details.images[0] ?? null,
      }
    }
    if (request.kind !== 'url') throw new RoomError('Unknown pack')
    const url = new URL(request.url)
    if (!isHostAllowed(url, this.config.importHosts)) {
      throw new RoomError(`Links from ${url.hostname} are not allowed. Upload the file instead.`)
    }
    let title = url.hostname
    try {
      title = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? url.hostname)
    } catch {
      // Keep the host name.
    }
    return { request: { kind: 'url', url: request.url }, title, pageUrl: null, imageUrl: null }
  }

  /** Starts (or finds) the server job for a request. Null for a pack that is already on the server. */
  private async startRequest(request: PackRequest, uploader: string): Promise<JobView | null> {
    if (request.kind === 'pack') return null
    if (request.kind === 'gamebanana') return this.gamebananaJob(request.modId, request.fileId)
    return this.packs.requestUrl(request.url, uploader)
  }

  /** Makes the request the current pack of the room, or starts its download. */
  private async useRequest(room: RoomRecord, request: PackRequest, uploader: string): Promise<JobView | null> {
    if (request.kind === 'pack') {
      if (!this.packs.manifest(request.packId)) throw new RoomError('That pack is no longer on the server', 404)
      this.setJob(room, null)
      room.randomPick = null
      this.applyPack(room, [request.packId])
      this.changed(room)
      return null
    }
    const job = await this.startRequest(request, uploader)
    return job ? this.attachJob(room, job) : null
  }

  async selectSource(code: string, actorId: string, request: SourceRequest): Promise<JobView | null> {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'lobby', 'results')
    if (request.kind === 'random') {
      this.randomRetries.delete(room.code)
      return this.randomSource(room)
    }
    const pick = await this.resolvePick(request)
    return this.useRequest(room, pick.request, this.playerName(code, actorId))
  }

  /** Starts the GameBanana job for a random pack that matches one of the room keywords. */
  private async randomSource(room: RoomRecord): Promise<JobView> {
    if (room.randomPick?.searching) throw new RoomError('The server already looks for a random pack', 409)
    const previous = room.randomPick
    const searching: RandomPickView = { searching: true, modId: null, name: null, keyword: null, matches: 0 }
    room.randomPick = searching
    this.changed(room)
    try {
      const currentModId =
        (room.packId ? this.packs.manifest(room.packId)?.source.modId : undefined) ?? previous?.modId ?? null
      const result = await pickRandomPack({
        keywords: room.keywords.map((keyword) => keyword.text),
        catalog: this.catalog,
        played: new Set(room.playedModIds),
        unusable: this.unusableMods,
        currentModId,
        maxBytes: this.config.downloadMaxBytes,
      })
      if (!result.ok) throw new RoomError(RANDOM_ERRORS[result.reason])
      if (room.randomPick !== searching || (room.phase !== 'lobby' && room.phase !== 'results')) {
        throw new RoomError('The pack changed while the server looked for a random pack', 409)
      }
      const { pick } = result
      const job = await this.gamebananaJob(pick.modId, pick.fileId)
      this.rememberPlayed(room, pick.modId)
      return this.attachJob(room, job, {
        searching: false,
        modId: pick.modId,
        name: pick.name,
        keyword: pick.keyword,
        matches: pick.matches,
      })
    } catch (error) {
      if (room.randomPick === searching) {
        room.randomPick = previous
        this.changed(room)
      }
      throw error
    }
  }

  private rememberPlayed(room: RoomRecord, modId: number | undefined): void {
    if (!modId) return
    room.playedModIds = [...room.playedModIds.filter((id) => id !== modId), modId].slice(-MAX_PLAYED_MODS)
  }

  /** The archive of a random pick has no usable pack (some mods only have a note or a link): pick another pack. */
  private retryRandomPick(room: RoomRecord): void {
    const modId = room.randomPick && !room.randomPick.searching ? room.randomPick.modId : null
    if (!modId || (room.phase !== 'lobby' && room.phase !== 'results')) return
    this.unusableMods.add(modId)
    const tries = this.randomRetries.get(room.code) ?? 0
    if (tries >= RANDOM_AUTO_RETRIES) return
    this.randomRetries.set(room.code, tries + 1)
    void this.randomSource(room).catch((error: unknown) => {
      if (!(error instanceof RoomError)) this.log.warn({ err: error }, 'random pack retry failed')
    })
  }

  addKeywords(code: string, actorId: string, text: string): void {
    const room = this.get(code)
    if (!room.players.some((player) => player.id === actorId)) throw new RoomError('Unknown player')
    const existing = new Set(room.keywords.map((keyword) => keyword.text.toLowerCase()))
    const added = parseKeywords(text).filter((keyword) => !existing.has(keyword.toLowerCase()))
    if (added.length === 0) return
    if (room.keywords.length + added.length > MAX_KEYWORDS) {
      throw new RoomError(`The list can have at most ${MAX_KEYWORDS} keywords`)
    }
    room.keywords = [...room.keywords, ...added.map((keyword) => ({ text: keyword, playerId: actorId }))]
    this.changed(room)
  }

  removeKeyword(code: string, actorId: string, keyword: string): void {
    const room = this.get(code)
    if (!room.players.some((player) => player.id === actorId)) throw new RoomError('Unknown player')
    const key = keyword.trim().toLowerCase()
    room.keywords = room.keywords.filter((entry) => entry.text.toLowerCase() !== key)
    this.changed(room)
  }

  private async gamebananaJob(modId: number, fileId: number): Promise<JobView> {
    const details = await this.catalog.details(modId).catch(() => {
      throw new RoomError('GameBanana did not return that mod')
    })
    const file = details.files.find((entry) => entry.id === fileId)
    if (!file) throw new RoomError('That file does not belong to the mod')
    if (file.size > this.config.downloadMaxBytes) throw new RoomError('That pack is larger than the download limit')
    return this.packs.requestGameBanana({
      modId,
      fileId,
      modName: details.name,
      fileName: file.name,
      size: file.size,
      pageUrl: details.profileUrl,
      images: details.images,
      description: details.description || details.text,
    })
  }

  /** The host stops the download of the current pack, or dismisses its error. */
  cancelJob(code: string, actorId: string): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    if (!room.jobKey && !room.randomPick) return
    this.setJob(room, null)
    if (!room.randomPick?.searching) room.randomPick = null
    this.changed(room)
  }

  // ---------------------------------------------------------------- suggestions and queue

  private requireMember(room: RoomRecord, actorId: string): PlayerRecord {
    const player = room.players.find((entry) => entry.id === actorId)
    if (!player) throw new RoomError('Unknown player', 403)
    return player
  }

  /** After the host uses a pack on the results page, the room goes back to the lobby with the new pack. */
  private leaveResults(room: RoomRecord): void {
    if (room.phase !== 'results') return
    room.phase = 'lobby'
    room.round = null
    room.playback = null
    room.votes = {}
  }

  async addSuggestion(code: string, actorId: string, request: SourceRequest): Promise<PackPick> {
    const room = this.get(code)
    this.requireMember(room, actorId)
    const resolved = await this.resolvePick(request)
    const key = requestKey(resolved.request)
    const existing = room.suggestions.find((entry) => requestKey(entry.request) === key)
    if (existing) return existing
    if (room.queue.some((entry) => requestKey(entry.request) === key)) {
      throw new RoomError('That pack is already in the queue', 409)
    }
    if (room.suggestions.length >= MAX_SUGGESTIONS) {
      throw new RoomError('There are too many suggestions. The host must remove some first.', 409)
    }
    const suggestion: PackPick = { id: randomId(8), ...resolved, by: actorId, at: Date.now() }
    room.suggestions.push(suggestion)
    this.changed(room)
    return suggestion
  }

  removeSuggestion(code: string, actorId: string, id: string): void {
    const room = this.get(code)
    const entry = room.suggestions.find((value) => value.id === id)
    if (!entry) return
    if (entry.by !== actorId) this.requireHost(room, actorId)
    room.suggestions = room.suggestions.filter((value) => value.id !== id)
    this.changed(room)
  }

  async useSuggestion(code: string, actorId: string, id: string): Promise<void> {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'lobby', 'results')
    const entry = room.suggestions.find((value) => value.id === id)
    if (!entry) throw new RoomError('That suggestion was removed', 404)
    await this.useRequest(room, entry.request, this.playerName(code, entry.by))
    room.suggestions = room.suggestions.filter((value) => value.id !== id)
    this.leaveResults(room)
    this.changed(room)
  }

  /** Starts the server job of a queued pack, so that it is ready when the host wants it. */
  private async prepareEntry(room: RoomRecord, entry: QueueRecord): Promise<void> {
    entry.error = null
    try {
      if (entry.request.kind === 'pack') {
        if (!this.packs.manifest(entry.request.packId)) throw new RoomError('That pack is no longer on the server')
        entry.packIds = [entry.request.packId]
        entry.jobKey = null
        return
      }
      const uploader = room.players.find((player) => player.id === entry.by)?.name ?? 'Player'
      const job = await this.startRequest(entry.request, uploader)
      if (!job) return
      if (job.stage === 'ready') {
        entry.packIds = job.packIds
        entry.jobKey = null
        for (const packId of job.packIds) this.packs.touch(packId)
      } else if (job.stage === 'error') {
        entry.error = job.message ?? 'The pack could not be prepared'
        entry.jobKey = null
      } else {
        entry.jobKey = job.key
      }
    } catch (error) {
      entry.jobKey = null
      entry.error = error instanceof RoomError ? error.message : 'The pack could not be prepared'
      if (!(error instanceof RoomError)) this.log.warn({ err: error }, 'queued pack failed')
    }
  }

  private async enqueue(room: RoomRecord, pick: PackPick): Promise<QueueRecord> {
    const key = requestKey(pick.request)
    const existing = room.queue.find((entry) => requestKey(entry.request) === key)
    if (!existing && room.queue.length >= MAX_QUEUE) throw new RoomError(`The queue is full (${MAX_QUEUE} packs)`, 409)
    room.suggestions = room.suggestions.filter((value) => requestKey(value.request) !== key)
    if (existing) {
      this.changed(room)
      return existing
    }
    const entry: QueueRecord = { ...pick, jobKey: null, packIds: [], error: null }
    room.queue.push(entry)
    this.changed(room)
    await this.prepareEntry(room, entry)
    // The host can remove the entry while the server looks up the pack.
    if (!room.queue.includes(entry)) this.releaseJob(entry.jobKey)
    this.changed(room)
    return entry
  }

  async addToQueue(code: string, actorId: string, request: SourceRequest): Promise<PackPick> {
    const room = this.get(code)
    this.requireHost(room, actorId)
    const resolved = await this.resolvePick(request)
    return this.enqueue(room, { id: randomId(8), ...resolved, by: actorId, at: Date.now() })
  }

  async queueSuggestion(code: string, actorId: string, id: string): Promise<void> {
    const room = this.get(code)
    this.requireHost(room, actorId)
    const entry = room.suggestions.find((value) => value.id === id)
    if (!entry) throw new RoomError('That suggestion was removed', 404)
    await this.enqueue(room, entry)
  }

  async useQueueEntry(code: string, actorId: string, id: string): Promise<void> {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'lobby', 'results')
    const entry = room.queue.find((value) => value.id === id)
    if (!entry) throw new RoomError('That pack is no longer in the queue', 404)
    const job = this.packs.job(entry.jobKey)
    if (entry.packIds.length > 0 && entry.packIds.every((packId) => this.packs.manifest(packId))) {
      this.setJob(room, null)
      room.randomPick = null
      this.applyPack(room, entry.packIds)
    } else if (job && job.stage !== 'error') {
      this.attachJob(room, job)
    } else {
      await this.useRequest(room, entry.request, this.playerName(code, entry.by))
    }
    room.queue = room.queue.filter((value) => value.id !== id)
    this.leaveResults(room)
    this.changed(room)
  }

  removeQueueEntry(code: string, actorId: string, id: string): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    const entry = room.queue.find((value) => value.id === id)
    if (!entry) return
    room.queue = room.queue.filter((value) => value.id !== id)
    this.releaseJob(entry.jobKey)
    this.changed(room)
  }

  attachUploadJob(code: string, actorId: string, job: JobView): JobView {
    const room = this.get(code)
    if (room.hostId !== actorId || (room.phase !== 'lobby' && room.phase !== 'results')) return job
    return this.attachJob(room, job)
  }

  selectPack(code: string, actorId: string, packId: string): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'lobby', 'results')
    const isVersion = Boolean(room.packId && this.packs.versions(room.packId).some((entry) => entry.id === packId))
    if ((!room.packChoices.includes(packId) && !isVersion) || !this.packs.manifest(packId)) {
      throw new RoomError('Unknown pack', 404)
    }
    if (!room.packChoices.includes(packId)) room.packChoices = [packId]
    room.packId = packId
    room.cast = {}
    this.packs.touch(packId)
    this.packs.prioritizeVideo(packId)
    this.changed(room)
  }

  castAssign(code: string, actorId: string, character: string, playerId: string | null): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'lobby', 'results')
    const manifest = room.packId ? this.packs.manifest(room.packId) : null
    if (!manifest?.characters.some((entry) => entry.name === character)) throw new RoomError('Unknown character')
    if (playerId === null) delete room.cast[character]
    else {
      if (!room.players.some((player) => player.id === playerId && !player.spectator)) {
        throw new RoomError('Unknown player')
      }
      room.cast[character] = playerId
    }
    this.changed(room)
  }

  castAuto(code: string, actorId: string): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'lobby', 'results')
    const manifest = room.packId ? this.packs.manifest(room.packId) : null
    if (!manifest) throw new RoomError('Choose a pack first')
    const players = this.activePlayers(room)
    if (players.length === 0) throw new RoomError('Nobody can record')
    room.cast = autoCast(
      manifest,
      shuffle(players).map((player) => player.id),
    )
    this.changed(room)
  }

  setSpectator(code: string, actorId: string, spectator: boolean): void {
    const room = this.get(code)
    this.requirePhase(room, 'lobby', 'results')
    const player = room.players.find((entry) => entry.id === actorId)
    if (!player) throw new RoomError('Unknown player')
    player.spectator = spectator
    if (spectator) {
      for (const [character, playerId] of Object.entries(room.cast)) if (playerId === actorId) delete room.cast[character]
    }
    this.changed(room)
  }

  kick(code: string, actorId: string, targetId: string): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    if (targetId === actorId) throw new RoomError('You cannot remove yourself')
    const target = room.players.find((player) => player.id === targetId)
    if (!target) throw new RoomError('Unknown player')
    room.players = room.players.filter((player) => player.id !== targetId)
    this.tokens.delete(target.tokenHash)
    this.assets.delete(targetId)
    this.progress.delete(targetId)
    for (const [character, playerId] of Object.entries(room.cast)) if (playerId === targetId) delete room.cast[character]
    delete room.votes[targetId]
    this.emit('kicked', room.code, targetId)
    this.startPlaybackWhenFinished(room)
    this.changed(room)
  }

  transferHost(code: string, actorId: string, targetId: string): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    if (!room.players.some((player) => player.id === targetId)) throw new RoomError('Unknown player')
    room.hostId = targetId
    this.changed(room)
  }

  // ---------------------------------------------------------------- rounds

  async startRound(code: string, actorId: string): Promise<void> {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'lobby', 'results')
    const manifest = room.packId ? this.packs.manifest(room.packId) : null
    if (!manifest) throw new RoomError('Choose a pack first')
    if (manifest.lines.length === 0) throw new RoomError('That pack has no lines')
    const players = this.activePlayers(room)
    if (players.length === 0) throw new RoomError('At least one player must take part')
    const mode = room.settings.mode
    if (mode === 'cast') {
      const kept: Record<string, string> = {}
      for (const [character, playerId] of Object.entries(room.cast)) {
        if (players.some((player) => player.id === playerId)) kept[character] = playerId
      }
      room.cast = autoCast(
        manifest,
        players.map((player) => player.id),
        kept,
      )
    }
    await removeDir(this.roomDir(room))
    room.round = {
      id: randomId(6),
      packId: manifest.id,
      mode,
      dubs: buildDubs(manifest, mode, players, room.cast),
      startedAt: Date.now(),
      finished: {},
    }
    room.phase = 'recording'
    room.votes = {}
    room.playback = null
    for (const player of room.players) this.progress.delete(player.id)
    this.rememberPlayed(room, manifest.source.modId)
    this.packs.touch(manifest.id)
    this.packs.prioritizeVideo(manifest.id)
    this.changed(room)
  }

  joinRound(code: string, actorId: string): void {
    const room = this.get(code)
    this.requirePhase(room, 'recording')
    const round = room.round
    const manifest = round ? this.packs.manifest(round.packId) : null
    if (!round || !manifest) throw new RoomError('There is no round')
    if (round.mode !== 'versus') throw new RoomError('Late players can join only Versus rounds')
    if (round.dubs.some((dub) => dub.ownerId === actorId)) return
    const player = room.players.find((entry) => entry.id === actorId)
    if (!player) throw new RoomError('Unknown player')
    player.spectator = false
    round.dubs.push(...buildDubs(manifest, 'versus', [player], {}))
    this.changed(room)
  }

  /** Marks the player as finished. When every player has finished, the room goes to playback. */
  finishRecording(code: string, actorId: string): void {
    const room = this.get(code)
    this.requirePhase(room, 'recording')
    const round = room.round
    if (!round) throw new RoomError('There is no round')
    const missing = round.dubs.reduce(
      (sum, dub) =>
        sum +
        Object.entries(dub.assignments).filter(
          ([lineId, playerId]) => playerId === actorId && dub.recordings[lineId]?.playerId !== actorId,
        ).length,
      0,
    )
    if (missing > 0) throw new RoomError(`Record every line first (${missing} missing)`)
    round.finished[actorId] = true
    this.startPlaybackWhenFinished(room)
    this.changed(room)
  }

  private startPlaybackWhenFinished(room: RoomRecord): void {
    if (room.phase !== 'recording' || !room.round) return
    if (unfinishedPlayers(room).length === 0) this.enterPlayback(room)
  }

  private enterPlayback(room: RoomRecord): void {
    const first = room.round?.dubs[0]
    if (!first) throw new RoomError('There is no round')
    if (room.phase === 'recording' || !room.playback) {
      room.playback = { dubId: first.id, status: 'paused', position: 0, startedAt: Date.now(), seq: (room.playback?.seq ?? 0) + 1 }
    }
    room.phase = 'playback'
  }

  setPhase(code: string, actorId: string, phase: RoomPhase): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    const round = room.round
    switch (phase) {
      case 'lobby':
        room.round = null
        room.playback = null
        room.votes = {}
        break
      case 'recording':
        this.requirePhase(room, 'playback', 'results')
        if (!round) throw new RoomError('There is no round')
        room.playback = null
        round.finished = {}
        break
      case 'playback': {
        this.requirePhase(room, 'recording', 'voting', 'results')
        if (!round || round.dubs.length === 0) throw new RoomError('There is no round')
        if (room.phase === 'recording' && unfinishedPlayers(room).length > 0) {
          throw new RoomError('Playback starts when every player has finished recording')
        }
        this.enterPlayback(room)
        break
      }
      case 'voting':
        this.requirePhase(room, 'playback', 'results')
        if (!round || round.dubs.length < 2) throw new RoomError('Voting needs at least two dubs')
        this.pausePlayback(room)
        break
      case 'results':
        this.requirePhase(room, 'playback', 'voting')
        this.pausePlayback(room)
        break
    }
    room.phase = phase
    this.changed(room)
  }

  private pausePlayback(room: RoomRecord): void {
    if (room.playback?.status === 'playing') {
      const now = Date.now()
      room.playback = {
        ...room.playback,
        status: 'paused',
        position: Math.max(0, playbackPosition(room.playback, now)),
        startedAt: now,
        seq: room.playback.seq + 1,
      }
    }
  }

  playbackControl(
    code: string,
    actorId: string,
    action: 'play' | 'pause' | 'seek' | 'select' | 'stop',
    dubId?: string,
    position?: number,
  ): void {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'playback', 'voting', 'results')
    const round = room.round
    if (!round || round.dubs.length === 0) throw new RoomError('There is no round')
    const manifest = this.packs.manifest(round.packId)
    const duration = manifest?.duration ?? 0
    const now = Date.now()
    const current: PlaybackState = room.playback ?? {
      dubId: round.dubs[0]?.id ?? '',
      status: 'paused',
      position: 0,
      startedAt: now,
      seq: 0,
    }
    const currentPosition = Math.min(duration, Math.max(0, playbackPosition(current, now)))
    const targetDub = dubId ?? current.dubId
    if (!round.dubs.some((dub) => dub.id === targetDub)) throw new RoomError('Unknown dub')
    const seq = current.seq + 1
    switch (action) {
      case 'select':
      case 'stop':
        room.playback = { dubId: targetDub, status: 'paused', position: 0, startedAt: now, seq }
        break
      case 'play': {
        const from = position ?? (currentPosition >= duration - 0.1 ? 0 : currentPosition)
        room.playback = { dubId: targetDub, status: 'playing', position: from, startedAt: now + PLAYBACK_LEAD_MS, seq }
        break
      }
      case 'pause':
        room.playback = { ...current, status: 'paused', position: currentPosition, startedAt: now, seq }
        break
      case 'seek': {
        const to = Math.min(duration, Math.max(0, position ?? 0))
        room.playback =
          current.status === 'playing'
            ? { ...current, position: to, startedAt: now + PLAYBACK_LEAD_MS, seq }
            : { ...current, position: to, startedAt: now, seq }
        break
      }
    }
    this.changed(room)
  }

  vote(code: string, actorId: string, dubId: string): void {
    const room = this.get(code)
    this.requirePhase(room, 'voting')
    const dub = room.round?.dubs.find((entry) => entry.id === dubId)
    if (!dub) throw new RoomError('Unknown dub')
    if (dub.ownerId === actorId) throw new RoomError('You cannot vote for your own dub')
    room.votes[actorId] = dubId
    const voters = room.players.filter((player) => this.isConnected(player.id))
    if (voters.length > 0 && voters.every((player) => room.votes[player.id])) {
      room.phase = 'results'
    }
    this.changed(room)
  }

  updateProgress(code: string, playerId: string, progress: ProgressView): void {
    if (!this.rooms.has(code)) return
    this.progress.set(playerId, progress)
    this.emit('progress', code, playerId, progress)
  }

  updateAssets(code: string, playerId: string, assets: AssetStatus): void {
    if (!this.rooms.has(code)) return
    this.assets.set(playerId, assets)
    this.emit('assets', code, playerId, assets)
  }

  // ---------------------------------------------------------------- recordings

  async addRecording(
    code: string,
    playerId: string,
    dubId: string,
    lineId: string,
    body: Buffer,
    contentType: string,
    timing: { lead?: number; mic?: string } = {},
  ): Promise<RecordingView> {
    const room = this.get(code)
    this.requirePhase(room, 'recording')
    const dub = room.round?.dubs.find((entry) => entry.id === dubId)
    if (!dub) throw new RoomError('Unknown dub', 404)
    if (dub.assignments[lineId] !== playerId) throw new RoomError('That line is not yours', 403)
    if (room.round?.finished[playerId]) throw new RoomError('You have already finished recording', 409)
    if (body.length < 200) throw new RoomError('The recording is empty')
    const line = this.packs.manifest(room.round?.packId ?? '')?.lines.find((entry) => entry.id === lineId)
    const maxSeconds = line?.promptDuration ?? 0
    const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
    const extension = AUDIO_EXTENSIONS[mime] ?? 'bin'
    const dir = this.roomDir(room)
    await ensureDir(path.join(dir, 'tmp'))
    await ensureDir(path.join(dir, 'rec'))
    const id = randomId(9)
    const temp = path.join(dir, 'tmp', `${id}.${extension}`)
    const output = path.join(dir, 'rec', `${id}.m4a`)
    await fs.writeFile(temp, body)
    let duration = 0
    try {
      const result = await this.media.processRecording(temp, output, {
        maxSeconds,
        lead: timing.lead ?? 0,
        prompt: line?.promptUrl ? this.mediaPath(line.promptUrl) : null,
      })
      duration = result.duration
      this.log.info({ lineId, playerId, take: id, onset: result.onset, mic: timing.mic }, 'recording processed')
    } catch (error) {
      this.log.warn({ err: error, take: id, mic: timing.mic }, 'recording processing failed')
      throw new RoomError('The recording could not be read. Try again.')
    } finally {
      // Keep the upload as the browser sent it, so that a bad take can be examined.
      await ensureDir(path.join(dir, 'src'))
      await fs.rename(temp, path.join(dir, 'src', `${id}.${extension}`)).catch(() => fs.rm(temp, { force: true }))
    }
    if (duration < 0.05) {
      await fs.rm(output, { force: true })
      throw new RoomError('The recording is empty')
    }
    const score = await this.scoreTake(room.round?.packId, lineId, output)
    // The round can change while ffmpeg runs.
    const current = room.round?.dubs.find((entry) => entry.id === dubId)
    if (!current || current.assignments[lineId] !== playerId) {
      await fs.rm(output, { force: true })
      throw new RoomError('The round has changed', 409)
    }
    const previous = current.recordings[lineId]
    if (previous) {
      const previousPath = this.mediaPath(previous.url)
      if (previousPath) await fs.rm(previousPath, { force: true })
    }
    const recording: RecordingView = {
      id,
      playerId,
      url: `/media/rooms/${room.id}/rec/${id}.m4a`,
      duration: Math.round(duration * 1000) / 1000,
      createdAt: Date.now(),
      score,
    }
    current.recordings[lineId] = recording
    current.export = { status: 'idle', progress: 0 }
    this.changed(room)
    return recording
  }

  /** Compares the loudness envelope of a processed take with the original line. Null if it cannot be measured. */
  private async scoreTake(packId: string | undefined, lineId: string, takeFile: string): Promise<number | null> {
    try {
      const line = packId ? this.packs.manifest(packId)?.lines.find((entry) => entry.id === lineId) : undefined
      const promptFile = line?.promptUrl ? this.mediaPath(line.promptUrl) : null
      if (!promptFile) return null
      let original = this.promptEnvelopes.get(promptFile)
      if (!original) {
        original = loudnessEnvelope(await this.media.decodePcm(promptFile, SCORE_SAMPLE_RATE))
        if (this.promptEnvelopes.size >= 2000) this.promptEnvelopes.clear()
        this.promptEnvelopes.set(promptFile, original)
      }
      if (original.length === 0) return null
      const take = loudnessEnvelope(await this.media.decodePcm(takeFile, SCORE_SAMPLE_RATE))
      return matchEnvelopes(original, take).score
    } catch (error) {
      this.log.warn({ err: error }, 'recording score failed')
      return null
    }
  }

  exportDub(code: string, actorId: string, dubId: string): void {
    const room = this.get(code)
    if (!room.players.some((player) => player.id === actorId)) throw new RoomError('Unknown player')
    const round = room.round
    const dub = round?.dubs.find((entry) => entry.id === dubId)
    if (!round || !dub) throw new RoomError('Unknown dub', 404)
    if (dub.export.status === 'rendering' || dub.export.status === 'ready') return
    const manifest = this.packs.manifest(round.packId)
    if (!manifest || manifest.videoStatus !== 'ready') throw new RoomError('The video is not ready yet')
    dub.export = { status: 'rendering', progress: 0 }
    this.changed(room)
    const fillMissing = room.settings.fillMissingWithOriginal
    const packDir = this.packs.packDir(manifest.id)
    this.exportChain = this.exportChain.then(async () => {
      const dir = path.join(this.roomDir(room), 'export')
      await ensureDir(dir)
      const fileName = `${dub.id}-${randomId(5)}.mp4`
      let lastEmit = 0
      try {
        const cues = buildCues(manifest, dub, fillMissing)
        const names = new Map(room.players.map((player) => [player.id, player.name]))
        await this.media.renderDub({
          video: path.join(packDir, 'video.mp4'),
          backing: manifest.backingUrl ? path.join(packDir, 'backing.mp3') : null,
          cues: cues
            .map((cue) => ({ file: cue.url ? this.mediaPath(cue.url) : null, time: cue.time }))
            .filter((cue): cue is { file: string; time: number } => Boolean(cue.file)),
          subtitles: cues.map((cue) => {
            const voice = cue.original ? 'original' : (names.get(cue.playerId ?? '') ?? '')
            return {
              start: cue.time,
              end: cue.time + Math.max(cue.duration, 1.2) + 0.3,
              text: `${cue.characters.join(' & ')}${voice ? ` (${voice})` : ''}: ${cue.text}`,
            }
          }),
          subtitleFile: path.join(dir, `${dub.id}.srt`),
          duration: manifest.duration,
          output: path.join(dir, fileName),
          onProgress: (fraction) => {
            dub.export.progress = fraction
            const now = Date.now()
            if (now - lastEmit > 1500) {
              lastEmit = now
              this.emit('state', room.code)
            }
          },
        })
        dub.export = { status: 'ready', progress: 1, url: `/media/rooms/${room.id}/export/${fileName}` }
      } catch (error) {
        this.log.warn({ err: error }, 'dub export failed')
        dub.export = { status: 'error', progress: 0, error: 'The export failed' }
      }
      if (this.rooms.has(room.code)) this.changed(room)
    })
  }

  // ---------------------------------------------------------------- cleanup

  async sweep(force = false): Promise<void> {
    const now = Date.now()
    const idleMs = this.config.roomIdleHours * 3_600_000
    const candidates = [...this.rooms.values()]
      .filter((room) => !room.players.some((player) => this.isConnected(player.id)))
      .sort((a, b) => (a.emptySince ?? a.updatedAt) - (b.emptySince ?? b.updatedAt))
    for (const room of candidates) {
      const emptyFor = now - (room.emptySince ?? room.updatedAt)
      if (emptyFor < idleMs && !(force && emptyFor > 10 * 60_000)) continue
      this.rooms.delete(room.code)
      for (const player of room.players) this.tokens.delete(player.tokenHash)
      await removeDir(this.roomDir(room))
      this.emit('closed', room.code)
      if (force && this.rooms.size < this.config.maxRooms) break
    }
    this.scheduleSave()
  }
}
