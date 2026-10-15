import path from 'node:path'

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (!raw) return fallback
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

export interface AppConfig {
  host: string
  port: number
  dataDir: string
  webRoot: string | null
  trustProxy: boolean
  logLevel: string
  ffmpeg: string
  ffprobe: string
  archiveTool: string
  videoMaxHeight: number
  videoCrf: number
  videoPreset: string
  ffmpegThreads: number
  packCacheMaxBytes: number
  downloadMaxBytes: number
  uploadMaxBytes: number
  catalogEnabled: boolean
  catalogRefreshHours: number
  importHosts: string[]
  roomIdleHours: number
  maxRooms: number
  userAgent: string
}

export function loadConfig(): AppConfig {
  // `npm run dev` runs inside apps/server; INIT_CWD is the folder where npm was started.
  const baseDir = process.env.INIT_CWD ?? process.cwd()
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(baseDir, 'data'))
  const webRoot = process.env.WEB_ROOT ? path.resolve(process.env.WEB_ROOT) : null
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: readNumber('PORT', 3000),
    dataDir,
    webRoot,
    trustProxy: process.env.TRUST_PROXY === 'true',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
    archiveTool: process.env.ARCHIVE_TOOL ?? (process.platform === 'win32' ? 'tar' : 'bsdtar'),
    videoMaxHeight: readNumber('VIDEO_MAX_HEIGHT', 720),
    videoCrf: readNumber('VIDEO_CRF', 27),
    videoPreset: process.env.VIDEO_PRESET ?? 'veryfast',
    ffmpegThreads: readNumber('FFMPEG_THREADS', 0),
    packCacheMaxBytes: readNumber('PACK_CACHE_MAX_GB', 20) * 1024 ** 3,
    downloadMaxBytes: readNumber('DOWNLOAD_MAX_MB', 2048) * 1024 ** 2,
    uploadMaxBytes: readNumber('UPLOAD_MAX_MB', 2048) * 1024 ** 2,
    catalogEnabled: process.env.CATALOG_SYNC !== 'false',
    catalogRefreshHours: readNumber('CATALOG_REFRESH_HOURS', 6),
    importHosts: readList('IMPORT_ALLOWED_HOSTS', [
      'gamebanana.com',
      'files.gamebanana.com',
      'github.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com',
      'dropbox.com',
      'www.dropbox.com',
      'dl.dropboxusercontent.com',
      'drive.google.com',
      'drive.usercontent.google.com',
      'cdn.discordapp.com',
      'media.discordapp.net',
    ]),
    roomIdleHours: readNumber('ROOM_IDLE_HOURS', 6),
    maxRooms: readNumber('MAX_ROOMS', 300),
    userAgent:
      process.env.USER_AGENT ??
      'MultiplayerChoicerVoicer/0.1 (+https://github.com/throndir2/MultiplayerChoicerVoicer)',
  }
}
