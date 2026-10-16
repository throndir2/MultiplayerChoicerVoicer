import { promises as fs } from 'node:fs'
import path from 'node:path'
import { cleanCaption, type PackCharacter, type PackLine, type PackManifest, type PackSourceInfo } from '@mcv/shared'
import { ensureDir, fileSize, mapLimit, writeJsonAtomic } from '../util/fsx.js'
import type { Media } from '../util/media.js'
import type { RawPack } from './discover.js'

export const MANIFEST_FILE = 'manifest.json'
const LINE_IMAGE_WIDTH = 640
const ICON_WIDTH = 660

export function packUrl(packId: string, file: string): string {
  return `/media/packs/${encodeURIComponent(packId)}/${file}`
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch {
    await fs.copyFile(from, to)
    // The source is in the job's temp folder, which is removed later anyway.
    await fs.rm(from, { force: true }).catch(() => undefined)
  }
}

/**
 * Phase A: everything that the players need to record. It is fast, so a room can start
 * recording while phase B converts the video.
 */
export async function processPackPhaseA(options: {
  raw: RawPack
  packId: string
  source: PackSourceInfo
  outDir: string
  media: Media
  /** From `fingerprintPack`, read before phase A moves the video. */
  fingerprint?: { hash: string; builtAt: number | null }
  /** The path of the pack folder in the archive or upload, with `/` separators. */
  folder?: string
  onProgress: (fraction: number) => void
}): Promise<PackManifest> {
  const { raw, packId, outDir, media } = options
  await ensureDir(path.join(outDir, 'lines'))
  await ensureDir(path.join(outDir, 'source'))

  const probe = await media.probe(raw.videoPath)
  if (!probe.hasVideo) throw new Error(`The video of "${raw.title}" could not be read`)

  const total = raw.lines.length + 2
  let done = 0
  const step = () => {
    done += 1
    options.onProgress(Math.min(1, done / total))
  }

  const lines: PackLine[] = await mapLimit(raw.lines, 4, async (line, index) => {
    const id = `L${String(index + 1).padStart(3, '0')}`
    const imageFile = `lines/${id}.jpg`
    const audioFile = `lines/${id}.mp3`
    let imageUrl: string | null = null
    try {
      if (line.imagePath) {
        await media.imageToJpeg(line.imagePath, path.join(outDir, imageFile), LINE_IMAGE_WIDTH)
      } else {
        const at = Math.min(Math.max(0, (line.timestamps[0] ?? 0) + 0.2), Math.max(0, probe.duration - 0.1))
        await media.videoFrameToJpeg(raw.videoPath, path.join(outDir, imageFile), at, LINE_IMAGE_WIDTH)
      }
      imageUrl = packUrl(packId, imageFile)
    } catch {
      imageUrl = null
    }
    let promptUrl: string | null = null
    let promptDuration = 0
    if (line.audioPath) {
      try {
        await media.audioToMp3(line.audioPath, path.join(outDir, audioFile), true)
        promptDuration = await media.duration(path.join(outDir, audioFile))
        promptUrl = packUrl(packId, audioFile)
      } catch {
        promptUrl = null
      }
    }
    step()
    const characters = line.characters.length > 0 ? line.characters : ['Unknown']
    return {
      id,
      index,
      caption: line.caption,
      text: cleanCaption(line.caption),
      characters,
      timestamps: [...line.timestamps].sort((a, b) => a - b),
      promptUrl,
      promptDuration: Math.round(promptDuration * 1000) / 1000,
      promptBytes: promptUrl ? await fileSize(path.join(outDir, audioFile)) : 0,
      imageUrl,
      imageBytes: imageUrl ? await fileSize(path.join(outDir, imageFile)) : 0,
      file: line.name,
    }
  })

  let iconUrl: string | null = null
  try {
    if (raw.iconPath) await media.imageToJpeg(raw.iconPath, path.join(outDir, 'icon.jpg'), ICON_WIDTH)
    else await media.videoFrameToJpeg(raw.videoPath, path.join(outDir, 'icon.jpg'), Math.min(1, probe.duration / 2), ICON_WIDTH)
    iconUrl = packUrl(packId, 'icon.jpg')
  } catch {
    iconUrl = lines.find((line) => line.imageUrl)?.imageUrl ?? null
  }
  step()

  let backingUrl: string | null = null
  if (raw.backingPath) {
    try {
      await media.audioToMp3(raw.backingPath, path.join(outDir, 'backing.mp3'), false)
      backingUrl = packUrl(packId, 'backing.mp3')
    } catch {
      backingUrl = null
    }
  }
  step()

  const sourceVideo = path.join(outDir, 'source', `video${path.extname(raw.videoPath).toLowerCase()}`)
  await moveFile(raw.videoPath, sourceVideo)

  const characterMap = new Map<string, PackCharacter>()
  for (const line of lines) {
    for (const name of line.characters) {
      const entry = characterMap.get(name) ?? { name, lineCount: 0, seconds: 0 }
      entry.lineCount += 1
      entry.seconds += line.promptDuration * line.timestamps.length
      characterMap.set(name, entry)
    }
  }

  const manifest: PackManifest = {
    id: packId,
    title: raw.title,
    subtitle: raw.subtitle,
    authors: raw.authors,
    readme: raw.readme,
    source: options.source,
    duration: Math.round(probe.duration * 1000) / 1000,
    width: probe.width,
    height: probe.height,
    iconUrl,
    backingUrl,
    backingBytes: backingUrl ? await fileSize(path.join(outDir, 'backing.mp3')) : 0,
    videoUrl: null,
    videoBytes: 0,
    videoStatus: 'pending',
    videoProgress: 0,
    lines,
    characters: [...characterMap.values()]
      .map((entry) => ({ ...entry, seconds: Math.round(entry.seconds * 10) / 10 }))
      .sort((a, b) => b.seconds - a.seconds),
    createdAt: Date.now(),
    folder: options.folder ?? '',
  }
  if (options.fingerprint) {
    manifest.contentHash = options.fingerprint.hash
    manifest.builtAt = options.fingerprint.builtAt
  }
  await writeJsonAtomic(path.join(outDir, MANIFEST_FILE), manifest)
  return manifest
}

/** Phase B: converts the Theora clip to an H.264 MP4 that every browser can play. */
export async function processPackPhaseB(options: {
  manifest: PackManifest
  outDir: string
  media: Media
  onProgress: (fraction: number) => void
}): Promise<PackManifest> {
  const { manifest, outDir, media } = options
  const sourceDir = path.join(outDir, 'source')
  const entries = await fs.readdir(sourceDir).catch(() => [] as string[])
  const source = entries.find((name) => name.startsWith('video.'))
  if (!source) throw new Error('The source video is missing')
  const output = path.join(outDir, 'video.mp4')
  const temp = path.join(outDir, 'video.tmp.mp4')
  await media.transcodeVideo(path.join(sourceDir, source), temp, manifest.duration, options.onProgress)
  await fs.rename(temp, output)
  await fs.rm(sourceDir, { recursive: true, force: true })
  return {
    ...manifest,
    videoUrl: packUrl(manifest.id, 'video.mp4'),
    videoBytes: await fileSize(output),
    videoStatus: 'ready',
    videoProgress: 1,
  }
}
