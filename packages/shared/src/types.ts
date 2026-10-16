export const ROOM_CODE_LENGTH = 5
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const MAX_PLAYERS = 12
export const MAX_NAME_LENGTH = 24
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
/** Seconds that a trimmed recording starts after the line timestamp (prompts have ~0.15 s lead-in). */
export const RECORDING_OFFSET = 0.1
/** Delay between the host pressing play and the synchronised start on every client. */
export const PLAYBACK_LEAD_MS = 1500
/** Keywords in the shared room list for the random pack pick. */
export const MAX_KEYWORDS = 20
export const MAX_KEYWORD_LENGTH = 40

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
  /** The GameBanana page, so that the players can check the pack (for example its language) during the download. */
  pageUrl?: string
  /** Preview pictures from GameBanana. */
  images?: string[]
  description?: string
}

/** A normalised pack request: a GameBanana file, a direct link, or a pack that is already on the server. */
export type PackRequest =
  | { kind: 'gamebanana'; modId: number; fileId: number }
  | { kind: 'url'; url: string }
  | { kind: 'pack'; packId: string }

/** A pack that a player suggested, or that the host put in the queue. */
export interface PackPick {
  id: string
  request: PackRequest
  title: string
  pageUrl: string | null
  imageUrl: string | null
  /** playerId of the player who added it. */
  by: string
  at: number
}

export interface QueueEntryView extends PackPick {
  /** The server job that downloads and prepares the pack. Null when the pack is ready or failed. */
  job: JobView | null
  /** The first prepared pack, when the server is done. */
  pack: PackSummary | null
  error: string | null
}

export const MAX_SUGGESTIONS = 30
export const MAX_QUEUE = 10

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
  /** Show the line pictures and the video while the players record. Off keeps the scene a surprise until playback. */
  showSceneWhileRecording: boolean
  /** Let the players go back to earlier lines and record them again. */
  allowGoingBack: boolean
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  mode: 'versus',
  fillMissingWithOriginal: true,
  showSceneWhileRecording: false,
  allowGoingBack: false,
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
  /** playerId -> true when the player has finished recording. Playback starts when every player has finished. */
  finished: Record<string, boolean>
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

export interface RoomKeyword {
  text: string
  /** The player who added the keyword. */
  playerId: string
}

/** The last random pack pick of the room. The server clears it when the host chooses a pack in a different way. */
export interface RandomPickView {
  /** True while the server looks for a pack. */
  searching: boolean
  modId: number | null
  name: string | null
  /** The keyword that the pack matches. Null for a pick from the whole catalog. */
  keyword: string | null
  /** How many usable packs match the keyword (or the whole catalog). */
  matches: number
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
  /** Packs that players suggested. The host can use them now, put them in the queue, or remove them. */
  suggestions: PackPick[]
  /** Packs that the host queued. The server prepares them in the background. */
  queue: QueueEntryView[]
  /** Shared keyword list for the random pack pick. Every player can change it. */
  keywords: RoomKeyword[]
  randomPick: RandomPickView | null
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
  /** Stops the download of the current pack (or dismisses its error). */
  jobCancel: 'job:cancel',
  suggestionUse: 'suggestion:use',
  suggestionQueue: 'suggestion:queue',
  suggestionRemove: 'suggestion:remove',
  queueUse: 'queue:use',
  queueRemove: 'queue:remove',
  keywordAdd: 'keyword:add',
  keywordRemove: 'keyword:remove',
  castAssign: 'cast:assign',
  castAuto: 'cast:auto',
  roundStart: 'round:start',
  roundJoin: 'round:join',
  roundFinish: 'round:finish',
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
