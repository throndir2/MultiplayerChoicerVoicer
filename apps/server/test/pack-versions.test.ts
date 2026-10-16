import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'
import type { JobView } from '@mcv/shared'
import type { GameBananaClient } from '../src/catalog/gamebanana.js'
import type { AppConfig } from '../src/config.js'
import { PackService } from '../src/packs/pack-service.js'
import type { Media } from '../src/util/media.js'

const work = mkdtempSync(path.join(tmpdir(), 'mcv-versions-'))
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 3 }))

const noop = () => undefined
const log = { info: noop, warn: noop, error: noop, debug: noop } as unknown as FastifyBaseLogger
const write = (_input: string, output: string) => fs.writeFile(output, 'x')
const media = {
  probe: async () => ({ hasVideo: true, duration: 10, width: 640, height: 360 }),
  duration: async () => 1,
  imageToJpeg: write,
  videoFrameToJpeg: write,
  audioToMp3: write,
  transcodeVideo: write,
} as unknown as Media

/** Writes a small pack folder like the Pack Creator export, with all file times at `made`. */
function makePack(id: string, title: string, caption: string, made: string): string {
  const dir = path.join(work, 'incoming', id, title)
  mkdirSync(dir, { recursive: true })
  const files: Record<string, string> = {
    '_pack_info.ini': `[data]\r\n\r\ntitle="${title}"\r\nicon="icon.png"\r\nauthors=["Ann"]\r\nreadme=""\r\n`,
    'dub_video.ogv': 'video',
    '001_A.txt': `[data]\r\n\r\ncaption="${caption}"\r\nimage="001_A.png"\r\ndub_timestamps=[1.000]\r\ndub_characters=["A"]\r\n`,
    '001_A.mp3': 'audio',
    '001_A.png': 'image',
  }
  const time = new Date(made)
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text)
    utimesSync(path.join(dir, name), time, time)
  }
  return path.dirname(dir)
}

function upload(service: PackService, id: string, dir: string, isPublic: boolean): Promise<JobView> {
  return new Promise((resolve) => {
    const listener = (job: JobView) => {
      if (job.key !== `up:${id}` || (job.stage !== 'ready' && job.stage !== 'error')) return
      service.off('job', listener)
      resolve(job)
    }
    service.on('job', listener)
    service.requestUpload({ uploadId: id, dir, label: 'test', uploader: id, public: isPublic })
  })
}

describe('pack versions', () => {
  it('reuses the same files and lists an update as a second version', async () => {
    const config = { dataDir: path.join(work, 'data'), downloadMaxBytes: 1e9, packCacheMaxBytes: 1e12 } as AppConfig
    const service = new PackService(config, media, {} as GameBananaClient, log)
    await service.load()

    const first = await upload(service, 'one', makePack('one', 'My Pack', 'Hello', '2026-01-01T10:00:00Z'), true)
    expect(first.stage).toBe('ready')
    const [firstId] = first.packIds
    expect(service.manifest(firstId as string)?.builtAt).toBe(Date.parse('2026-01-01T10:00:00Z'))
    expect(service.manifest(firstId as string)?.folder).toBe('My Pack')
    expect(service.manifest(firstId as string)?.lines[0]?.file).toBe('001_A')

    // A pack from before the server kept the line file names gets them when the same files come again.
    const old = service.manifest(firstId as string)
    for (const line of old?.lines ?? []) delete line.file
    delete old?.folder

    // The same files again, with other file times: the server uses the pack that it has.
    const again = await upload(service, 'two', makePack('two', 'My Pack', 'Hello', '2026-03-01T10:00:00Z'), false)
    expect(again.packIds).toEqual([firstId])
    expect(service.manifest(firstId as string)?.source.public).toBe(true)
    expect(service.versions(firstId as string)).toEqual([])
    expect(service.manifest(firstId as string)?.lines[0]?.file).toBe('001_A')
    expect(service.manifest(firstId as string)?.folder).toBe('My Pack')

    // An update with a fix: a new version of the same pack.
    const fixed = await upload(service, 'three', makePack('three', 'My Pack (fixed)', 'Hello!', '2026-02-01T10:00:00Z'), true)
    const [fixedId] = fixed.packIds
    expect(fixedId).not.toBe(firstId)
    expect(service.versions(firstId as string).map((entry) => entry.id)).toEqual([fixedId, firstId])

    const listed = service.listRecent()
    expect(listed.map((entry) => entry.id)).toEqual([fixedId, firstId])
    expect(new Set(listed.map((entry) => entry.versionKey)).size).toBe(1)

    // The video step runs in the background. Let it finish before the folder is removed.
    for (let tries = 0; tries < 100; tries += 1) {
      if ([firstId, fixedId].every((id) => service.manifest(id as string)?.videoStatus === 'ready')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await service.flush()
  })
})
