import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import {
  MAX_PLAYERS,
  PLAYBACK_LEAD_MS,
  PLAYER_COLORS,
  SCORE_SAMPLE_RATE,
  buildCues,
  loudnessEnvelope,
  matchEnvelopes,
  playbackPosition,
  type AssetStatus,
  type DubView,
  type GameMode,
  type JobView,
  type PackManifest,
  type PlaybackState,
  type ProgressView,
  type RecordingView,
  type RoomInfoResponse,
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
import type { PackService } from '../packs/pack-service.js'
import { isHostAllowed } from '../util/download.js'
import { ensureDir, readJson, removeDir, writeJsonAtomic } from '../util/fsx.js'
import { createRoomCode, createToken, hashToken, randomId, shuffle } from '../util/ids.js'
import type { Media } from '../util/media.js'

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
      for (const room of this.rooms.values()) if (this.roomUsesPack(room, manifest.id)) this.emit('state', room.code)
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
    return room.packId === packId || room.packChoices.includes(packId) || room.round?.packId === packId
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
      settings: { mode: 'versus', fillMissingWithOriginal: true },
      packId: null,
      packChoices: [],
      jobKey: null,
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
      job: this.packs.job(room.jobKey),
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
    if (patch.mode && patch.mode !== room.settings.mode) this.requirePhase(room, 'lobby', 'results')
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
      if (room.jobKey !== job.key) continue
      if (job.stage === 'ready') {
        if (room.phase === 'lobby' || room.phase === 'results') this.applyPack(room, job.packIds)
        room.jobKey = null
        this.changed(room)
      } else if (job.stage === 'error') {
        this.changed(room)
      } else {
        this.emit('job', room.code, job)
      }
    }
  }

  private attachJob(room: RoomRecord, job: JobView): JobView {
    if (job.stage === 'ready') {
      this.applyPack(room, job.packIds)
      room.jobKey = null
    } else {
      room.jobKey = job.key
    }
    this.changed(room)
    return job
  }

  async selectSource(code: string, actorId: string, request: SourceRequest): Promise<JobView | null> {
    const room = this.get(code)
    this.requireHost(room, actorId)
    this.requirePhase(room, 'lobby', 'results')
    if (request.kind === 'pack') {
      if (!this.packs.manifest(request.packId)) throw new RoomError('That pack is no longer on the server', 404)
      this.applyPack(room, [request.packId])
      room.jobKey = null
      this.changed(room)
      return null
    }
    if (request.kind === 'gamebanana') return this.attachJob(room, await this.gamebananaJob(request.modId, request.fileId))
    const modId = parseGameBananaModUrl(request.url)
    if (modId) {
      const details = await this.catalog.details(modId).catch(() => {
        throw new RoomError('GameBanana did not return that mod')
      })
      const file = details.files.find((entry) => entry.isArchive) ?? details.files[0]
      if (!file) throw new RoomError('That GameBanana mod has no files')
      return this.attachJob(room, await this.gamebananaJob(modId, file.id))
    }
    const url = new URL(request.url)
    if (!isHostAllowed(url, this.config.importHosts)) {
      throw new RoomError(`Links from ${url.hostname} are not allowed. Upload the file instead.`)
    }
    return this.attachJob(room, this.packs.requestUrl(request.url, this.playerName(code, actorId)))
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
    })
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
    if (!room.packChoices.includes(packId) || !this.packs.manifest(packId)) throw new RoomError('Unknown pack', 404)
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
    }
    room.phase = 'recording'
    room.votes = {}
    room.playback = null
    for (const player of room.players) this.progress.delete(player.id)
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
        break
      case 'playback': {
        this.requirePhase(room, 'recording', 'voting', 'results')
        const first = round?.dubs[0]
        if (!round || !first) throw new RoomError('There is no round')
        if (room.phase === 'recording' || !room.playback) {
          room.playback = { dubId: first.id, status: 'paused', position: 0, startedAt: Date.now(), seq: (room.playback?.seq ?? 0) + 1 }
        }
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
  ): Promise<RecordingView> {
    const room = this.get(code)
    this.requirePhase(room, 'recording')
    const dub = room.round?.dubs.find((entry) => entry.id === dubId)
    if (!dub) throw new RoomError('Unknown dub', 404)
    if (dub.assignments[lineId] !== playerId) throw new RoomError('That line is not yours', 403)
    if (body.length < 200) throw new RoomError('The recording is empty')
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
      duration = await this.media.processRecording(temp, output)
    } catch (error) {
      this.log.warn({ err: error }, 'recording processing failed')
      throw new RoomError('The recording could not be read. Try again.')
    } finally {
      await fs.rm(temp, { force: true })
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
