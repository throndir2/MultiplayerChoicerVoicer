import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import {
  asNumberArray,
  asString,
  asStringArray,
  dataSection,
  parseGodotConfig,
  type GodotValue,
} from './godot-config.js'

export interface RawLine {
  name: string
  caption: string
  characters: string[]
  timestamps: number[]
  audioPath: string | null
  imagePath: string | null
}

export interface RawPack {
  dir: string
  title: string
  subtitle: string
  authors: string[]
  readme: string
  iconPath: string | null
  videoPath: string
  backingPath: string | null
  lines: RawLine[]
  warnings: string[]
}

const VIDEO_EXTENSIONS = ['.ogv', '.mp4', '.webm', '.mkv', '.mov']
const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.flac']
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']
export const ARCHIVE_EXTENSIONS = ['.zip', '.7z', '.rar', '.tar', '.tgz', '.gz']

async function readText(file: string): Promise<string> {
  const buffer = await fs.readFile(file)
  return buffer.toString('utf8')
}

/** Files that operating systems add to folders. They are not part of a pack. */
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
/** File times before this (and in the future) are not real dates. */
const EARLIEST_DATE = Date.UTC(2010, 0, 1)

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

export interface PackFingerprint {
  /** SHA-256 of the names and the contents of the pack files. */
  hash: string
  /** The newest file time, or null when the times are not real dates. */
  builtAt: number | null
}

/**
 * Identifies the files of a pack folder. An archive keeps the file times of the Pack Creator export,
 * so the newest file time is the date when the pack was made or last changed.
 */
export async function fingerprintPack(dir: string): Promise<PackFingerprint> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && !JUNK_FILES.has(entry.name.toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const hash = createHash('sha256')
  let newest = 0
  for (const name of files) {
    const file = path.join(dir, name)
    const stat = await fs.stat(file)
    newest = Math.max(newest, stat.mtimeMs)
    hash.update(`${name.toLowerCase()}\0${stat.size}\0${await hashFile(file)}\n`)
  }
  const builtAt = newest >= EARLIEST_DATE && newest <= Date.now() + 86_400_000 ? Math.round(newest) : null
  return { hash: hash.digest('hex'), builtAt }
}

/** Finds every folder that looks like a Choicer Voicer pack. */
export async function findPackDirs(root: string): Promise<string[]> {
  const withInfo: string[] = []
  const withVideo: string[] = []
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase())
    if (names.includes('_pack_info.ini')) withInfo.push(dir)
    else if (names.includes('dub_video.ogv')) withVideo.push(dir)
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '__MACOSX' && !entry.name.startsWith('.')) {
        await visit(path.join(dir, entry.name), depth + 1)
      }
    }
  }
  await visit(root, 0)
  const found = withInfo.length > 0 ? withInfo : withVideo
  return found.sort((a, b) => a.localeCompare(b))
}

export async function findArchives(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 6) return
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (ARCHIVE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) result.push(full)
    }
  }
  await visit(root, 0)
  return result
}

export async function readPack(dir: string): Promise<RawPack> {
  const warnings: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const byLower = new Map(files.map((name) => [name.toLowerCase(), name]))
  const find = (name: string): string | null => {
    const actual = byLower.get(name.toLowerCase())
    return actual ? path.join(dir, actual) : null
  }
  const findWithExtensions = (base: string, extensions: string[]): string | null => {
    for (const extension of extensions) {
      const found = find(`${base}${extension}`)
      if (found) return found
    }
    return null
  }

  let data: Record<string, GodotValue> = {}
  const infoPath = find('_pack_info.ini')
  if (infoPath) {
    data = dataSection(parseGodotConfig(await readText(infoPath)))
  } else {
    warnings.push('The pack has no _pack_info.ini file')
  }

  const title = asString(data.title).trim() || path.basename(dir)

  let videoPath = find('dub_video.ogv')
  if (!videoPath) {
    const candidate = files.find((name) => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    videoPath = candidate ? path.join(dir, candidate) : null
  }
  if (!videoPath) throw new Error(`The pack "${title}" has no dub_video.ogv`)

  let backingPath = find('_backing_track.mp3')
  if (!backingPath) {
    const candidate = files.find(
      (name) =>
        name.toLowerCase().startsWith('_backing_track.') && AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase()),
    )
    backingPath = candidate ? path.join(dir, candidate) : null
  }
  if (!backingPath) warnings.push('The pack has no backing track')

  const iconName = asString(data.icon).trim()
  const iconPath = (iconName ? find(path.basename(iconName)) : null) ?? find('icon.png')

  const lines: RawLine[] = []
  for (const name of files) {
    if (path.extname(name).toLowerCase() !== '.txt') continue
    const base = name.slice(0, -4)
    let section
    try {
      section = dataSection(parseGodotConfig(await readText(path.join(dir, name))))
    } catch {
      warnings.push(`Could not read ${name}`)
      continue
    }
    const timestamps = asNumberArray(section.dub_timestamps)
    if (timestamps.length === 0) continue
    const caption = asString(section.caption).trim()
    const characters = asStringArray(section.dub_characters)
    const imageName = asString(section.image).trim()
    const imagePath =
      (imageName ? find(path.basename(imageName)) : null) ?? findWithExtensions(base, IMAGE_EXTENSIONS)
    const audioPath = findWithExtensions(base, AUDIO_EXTENSIONS)
    if (!audioPath) warnings.push(`${name} has no audio file`)
    lines.push({ name: base, caption, characters, timestamps, audioPath, imagePath })
  }
  lines.sort(
    (a, b) => Math.min(...a.timestamps) - Math.min(...b.timestamps) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
  if (lines.length === 0) throw new Error(`The pack "${title}" has no dub lines`)

  return {
    dir,
    title,
    subtitle: asString(data.subtitle).trim(),
    authors: asStringArray(data.authors),
    readme: asString(data.readme).trim(),
    iconPath,
    videoPath,
    backingPath,
    lines,
    warnings,
  }
}
