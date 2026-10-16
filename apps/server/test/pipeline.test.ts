import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { SCORE_SAMPLE_RATE, matchScore } from '@mcv/shared'
import { loadConfig } from '../src/config.js'
import { findPackDirs, readPack } from '../src/packs/discover.js'
import { processPackPhaseA, processPackPhaseB } from '../src/packs/processor.js'
import { autoCast, buildDubs } from '../src/rooms/room-service.js'
import { Media } from '../src/util/media.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const work = mkdtempSync(path.join(tmpdir(), 'mcv-test-'))
const script = fileURLToPath(new URL('../../../scripts/make-sample-pack.mjs', import.meta.url))

afterAll(() => rmSync(work, { recursive: true, force: true }))

describe.skipIf(!hasFfmpeg)('pack pipeline', () => {
  it('processes the sample pack and a recording', async () => {
    const generated = spawnSync(process.execPath, [script, path.join(work, 'src')], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)

    const media = new Media(loadConfig())
    await media.extractArchive(path.join(work, 'src', 'Sample Pack.zip'), path.join(work, 'src'))
    const dirs = await findPackDirs(path.join(work, 'src'))
    expect(dirs).toHaveLength(1)
    const raw = await readPack(dirs[0] as string)
    expect(raw.title).toBe('Sample Pack')
    expect(raw.lines).toHaveLength(4)

    const outDir = path.join(work, 'out', 'test-1')
    const manifest = await processPackPhaseA({
      raw,
      packId: 'test-1',
      source: { kind: 'upload', name: 'test' },
      outDir,
      media,
      onProgress: () => undefined,
    })
    expect(manifest.lines[0]?.text).toBe('Hello there, is anybody home?')
    expect(manifest.lines[0]?.promptDuration).toBeGreaterThan(1)
    expect(manifest.lines[3]?.characters).toEqual(['Bob', 'Alice'])
    expect(manifest.characters.map((entry) => entry.name).sort()).toEqual(['Alice', 'Bob'])
    expect(existsSync(path.join(outDir, 'lines', 'L001.jpg'))).toBe(true)
    expect(manifest.videoStatus).toBe('pending')

    const done = await processPackPhaseB({ manifest, outDir, media, onProgress: () => undefined })
    expect(done.videoStatus).toBe('ready')
    expect(existsSync(path.join(outDir, 'video.mp4'))).toBe(true)
    const probe = await media.probe(path.join(outDir, 'video.mp4'))
    expect(probe.videoCodec).toBe('h264')

    const recording = path.join(work, 'take.m4a')
    const seconds = await media.processRecording(path.join(outDir, 'lines', 'L001.mp3'), recording)
    // 0.15 s lead-in + 1.6 s tone + 0.25 s tail. The trim keeps 0.06 s before and 0.2 s after the tone.
    expect(seconds).toBeGreaterThan(1.6)
    expect(seconds).toBeLessThan(1.95)

    // A take is never longer than the original line.
    const capped = path.join(work, 'capped.m4a')
    expect(await media.processRecording(path.join(outDir, 'lines', 'L001.mp3'), capped, 1)).toBeLessThanOrEqual(1)
    expect(await media.duration(capped)).toBeLessThan(1.05)

    const original = await media.decodePcm(path.join(outDir, 'lines', 'L001.mp3'), SCORE_SAMPLE_RATE)
    const take = await media.decodePcm(recording, SCORE_SAMPLE_RATE)
    expect(take.length / SCORE_SAMPLE_RATE).toBeGreaterThan(1.5)
    expect(matchScore(original, take)).toBeGreaterThanOrEqual(90)
    expect(matchScore(original, new Float32Array(SCORE_SAMPLE_RATE))).toBe(0)

    const players = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]
    const cast = autoCast(manifest, ['a', 'b'])
    expect(new Set(Object.values(cast)).size).toBe(2)
    const [ensemble] = buildDubs(manifest, 'cast', players, cast)
    expect(Object.keys(ensemble?.assignments ?? {})).toHaveLength(4)
    expect(buildDubs(manifest, 'versus', players, {})).toHaveLength(2)
    const [chaos] = buildDubs(manifest, 'chaos', players, {})
    expect(new Set(Object.values(chaos?.assignments ?? {})).size).toBe(2)
  }, 120_000)
})
