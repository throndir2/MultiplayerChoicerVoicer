export const ROOM_CODE_LENGTH = 5
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const MAX_PLAYERS = 12
export const MAX_NAME_LENGTH = 24
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
/** Seconds that a trimmed recording starts after the line timestamp (prompts have ~0.15 s lead-in). */
export const RECORDING_OFFSET = 0.1
/** Delay between the host pressing play and the synchronised start on every client. */
export const PLAYBACK_LEAD_MS = 1500

export const PLAYER_COLORS = [
  '#ff6b6b',
  '#4dabf7',
  '#51cf66',
  '#fcc419',
  '#cc5de8',
  '#ff922b',
  '#22b8cf',
  '#f06595',
  '#94d82d',
  '#845ef7',
  '#20c997',
  '#adb5bd',
] as const

export type GameMode = 'versus' | 'cast' | 'chaos'
export type RoomPhase = 'lobby' | 'recording' | 'playback' | 'voting' | 'results'
export type VideoStatus = 'pending' | 'processing' | 'ready' | 'error'
export type JobStage =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'extracting'
  | 'processing'
  | 'ready'
  | 'error'

export interface PackSourceInfo {
  kind: 'gamebanana' | 'upload' | 'url'
  name: string
  modId?: number
  fileId?: number
  pageUrl?: string
  url?: string
  uploader?: string
  public?: boolean
}

export interface PackLine {
  id: string
  index: number
  caption: string
  /** Caption without the leading `[Character]` tag and outer quotes, for subtitles. */
  text: string
  characters: string[]
  timestamps: number[]
  promptUrl: string | null
  promptDuration: number
  promptBytes: number
  imageUrl: string | null
  imageBytes: number
}

export interface PackCharacter {
  name: string
  lineCount: number
  seconds: number
}

export interface PackManifest {
  id: string
  title: string
  subtitle: string
  authors: string[]
  readme: string
  source: PackSourceInfo
  duration: number
  width: number
  height: number
  iconUrl: string | null
  backingUrl: string | null
  backingBytes: number
  videoUrl: string | null
  videoBytes: number
  videoStatus: VideoStatus
  videoProgress: number
  videoError?: string
  lines: PackLine[]
  characters: PackCharacter[]
  createdAt: number
}

export interface PackSummary {
  id: string
  title: string
  subtitle: string
  authors: string[]
  iconUrl: string | null
  lineCount: number
  characterCount: number
  duration: number
  videoStatus: VideoStatus
  videoProgress: number
  source: PackSourceInfo
  manifestUrl: string
}

export interface JobView {
  key: string
  label: string
  stage: JobStage
  progress: number
  message?: string
  packIds: string[]
}

export interface CatalogItem {
  id: number
  name: string
  submitter: string
  category: string
  thumbnailUrl: string | null
  profileUrl: string
  dateAdded: number
  dateModified: number
  likes: number
  views: number
  rated: boolean
  version: string
}

export interface CatalogCategory {
  name: string
  count: number
}

export interface CatalogResponse {
  items: CatalogItem[]
  total: number
  page: number
  pageSize: number
  categories: CatalogCategory[]
  syncedAt: number | null
  syncing: boolean
}

export interface ModFile {
  id: number
  name: string
  size: number
  description: string
  downloads: number
  isArchive: boolean
}

export interface ModDetails {
  id: number
  name: string
  submitter: string
  description: string
  text: string
  profileUrl: string
  images: string[]
  files: ModFile[]
  likes: number
  views: number
  downloads: number
}

export interface RoomSettings {
  mode: GameMode
  fillMissingWithOriginal: boolean
}

export interface AssetStatus {
  packId: string | null
  /** 0..1 for the images and prompts of my own lines. */
  lines: number
  backing: number
  video: number
  /** Downloaded recordings / known recordings. */
  recordings: number
  ready: boolean
}

export interface ProgressView {
  dubId: string | null
  lineId: string | null
  recording: boolean
}

export interface PlayerView {
  id: string
  name: string
  color: string
  connected: boolean
  spectator: boolean
  assets: AssetStatus | null
  progress: ProgressView | null
}

export interface RecordingView {
  id: string
  playerId: string
  url: string
  duration: number
  createdAt: number
  /** 0..100: how well the loudness envelope and the length match the original line. Null if it could not be measured. */
  score?: number | null
}

export interface DubExportView {
  status: 'idle' | 'rendering' | 'ready' | 'error'
  progress: number
  url?: string
  error?: string
}

export interface DubView {
  id: string
  name: string
  ownerId: string | null
  /** lineId -> playerId */
  assignments: Record<string, string>
  /** lineId -> recording */
  recordings: Record<string, RecordingView>
  export: DubExportView
}

export interface RoundView {
  id: string
  packId: string
  mode: GameMode
  dubs: DubView[]
  startedAt: number
}

export interface PlaybackState {
  dubId: string
  status: 'playing' | 'paused'
  /** Position in seconds at `startedAt`. */
  position: number
  /** Server epoch ms when `position` applies. */
  startedAt: number
  seq: number
}

export interface RoomView {
  code: string
  hostId: string
  phase: RoomPhase
  players: PlayerView[]
  settings: RoomSettings
  pack: PackSummary | null
  packChoices: PackSummary[]
  job: JobView | null
  /** character name -> playerId */
  cast: Record<string, string>
  round: RoundView | null
  playback: PlaybackState | null
  /** voterId -> dubId */
  votes: Record<string, string>
  serverNow: number
}

export interface SessionResponse {
  code: string
  playerId: string
  token: string
}

export interface RoomInfoResponse {
  code: string
  phase: RoomPhase
  playerCount: number
  hostName: string
  packTitle: string | null
}

export interface UploadCreateResponse {
  uploadId: string
}

export interface UploadStatusResponse {
  uploadId: string
  files: { path: string; size: number; received: number }[]
}

export interface Ack {
  ok: boolean
  error?: string
}

export interface TimeSyncAck extends Ack {
  now: number
}

export const ClientEvents = {
  settingsUpdate: 'settings:update',
  packSelect: 'pack:select',
  castAssign: 'cast:assign',
  castAuto: 'cast:auto',
  roundStart: 'round:start',
  roundJoin: 'round:join',
  phaseSet: 'phase:set',
  playerKick: 'player:kick',
  playerSpectate: 'player:spectate',
  hostTransfer: 'host:transfer',
  playbackControl: 'playback:control',
  voteCast: 'vote:cast',
  dubExport: 'dub:export',
  timeSync: 'time:sync',
  progressUpdate: 'progress:update',
  assetsUpdate: 'assets:update',
} as const

export const ServerEvents = {
  state: 'room:state',
  progress: 'room:progress',
  assets: 'room:assets',
  job: 'room:job',
  video: 'room:video',
  kicked: 'room:kicked',
  closed: 'room:closed',
} as const
