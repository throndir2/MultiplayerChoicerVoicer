import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'
import type { GameBananaClient } from '../src/catalog/gamebanana.js'
import type { AppConfig } from '../src/config.js'
import { PackService } from '../src/packs/pack-service.js'
import { makeTreeWritable, removeDir } from '../src/util/fsx.js'
import type { Media } from '../src/util/media.js'

const work = mkdtempSync(path.join(tmpdir(), 'mcv-cleanup-'))

afterAll(async () => {
  await makeTreeWritable(work)
  rmSync(work, { recursive: true, force: true })
})

/** Makes a folder like the one from the crash: a read-only pack folder with files in it. */
function readOnlyTree(root: string): string {
  const pack = path.join(root, 'extracted', 'Read Only Pack')
  mkdirSync(pack, { recursive: true })
  writeFileSync(path.join(pack, 'dub_video.ogv'), 'video')
  writeFileSync(path.join(pack, '01_Lenny.mp3'), 'audio')
  chmodSync(path.join(pack, '01_Lenny.mp3'), 0o444)
  chmodSync(pack, 0o555)
  return pack
}

const noop = () => undefined
const log = { info: noop, warn: noop, error: noop, debug: noop } as unknown as FastifyBaseLogger

describe('temporary folder cleanup', () => {
  it('removes a tree that has read-only folders', async () => {
    const root = path.join(work, 'remove')
    readOnlyTree(root)
    await removeDir(root)
    expect(existsSync(root)).toBe(false)
  })

  it('makes extracted folders writable', async () => {
    const root = path.join(work, 'writable')
    const pack = readOnlyTree(root)
    await makeTreeWritable(root)
    rmSync(path.join(pack, 'dub_video.ogv'))
    expect(existsSync(path.join(pack, 'dub_video.ogv'))).toBe(false)
  })

  it('cleans a temporary folder with read-only folders at startup', async () => {
    const dataDir = path.join(work, 'data')
    readOnlyTree(path.join(dataDir, 'tmp', 'job-abc123'))
    const service = new PackService(
      { dataDir } as AppConfig,
      {} as Media,
      {} as GameBananaClient,
      log,
    )
    await service.load()
    expect(readdirSync(path.join(dataDir, 'tmp'))).toEqual([])
  })
})
