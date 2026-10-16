import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { RECORDING_OFFSET, SCORE_SAMPLE_RATE, matchScore } from '@mcv/shared'
import { loadConfig } from '../src/config.js'
import { findPackDirs, readPack } from '../src/packs/discover.js'
import { processPackPhaseA, processPackPhaseB } from '../src/packs/processor.js'
import { autoCast, buildDubs } from '../src/rooms/room-service.js'
import { Media, runCommand } from '../src/util/media.js'
import { findDelay, speechBounds } from '../src/util/take.js'
import { RATE, addAt, addEcho, noise, scaleTo, voice } from './synthetic.js'

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
    const { duration: seconds } = await media.processRecording(path.join(outDir, 'lines', 'L001.mp3'), recording, {
      prompt: path.join(outDir, 'lines', 'L001.mp3'),
      guide: false,
    })
    // 0.15 s lead-in + 1.6 s tone + 0.25 s tail. The tone starts where it starts in the original line.
    expect(seconds).toBeGreaterThan(1.6)
    expect(seconds).toBeLessThan(1.95)

    // A take is never longer than the original line.
    const capped = path.join(work, 'capped.m4a')
    const cappedResult = await media.processRecording(path.join(outDir, 'lines', 'L001.mp3'), capped, { maxSeconds: 1 })
    expect(cappedResult.duration).toBeLessThanOrEqual(1)
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

  it('removes the original line from a browser take and puts the first word where the original has it', async () => {
    const media = new Media(loadConfig())
    const config = loadConfig()
    const dir = path.join(work, 'echo')
    mkdirSync(dir, { recursive: true })
    const lead = 1.5
    // The original line: its first word comes 0.3 s after the start.
    const original = new Float32Array(Math.round(2.9 * RATE))
    addAt(original, scaleTo(voice(2.5, 11), 0.1), 0.3)
    // The upload: the countdown in loud noise, the player (late by 0.45 s, with a pause), and a copy of the
    // original line 90 ms after it played.
    const upload = noise(Math.round((lead + 2.9) * RATE), 0.006, 12)
    addAt(upload, scaleTo(voice(2.3, 12, [[0.9, 1.4]]), 0.1), lead + 0.45)
    addEcho(upload, original, lead + 0.09, 0.4)
    const encode = async (samples: Float32Array, name: string, codec: string[]) => {
      const raw = path.join(dir, `${name}.f32`)
      writeFileSync(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
      const output = path.join(dir, name)
      await runCommand(config.ffmpeg, ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', raw, ...codec, output])
      return output
    }
    const promptFile = await encode(original, 'prompt.mp3', ['-c:a', 'libmp3lame', '-b:a', '96k'])
    const takeFile = await encode(upload, 'take.webm', ['-c:a', 'libopus', '-b:a', '128k'])
    const prompt = await media.decodePcm(promptFile, RATE)
    const promptOnset = speechBounds(prompt, RATE)?.onset ?? 0
    expect(Math.abs(promptOnset - 0.3)).toBeLessThan(0.03)
    const leftover = async (file: string) => {
      const samples = await media.decodePcm(file, RATE)
      return findDelay(samples, prompt, -RATE / 2, RATE / 2, RATE)?.strength ?? 0
    }

    const cleaned = path.join(dir, 'cleaned.m4a')
    const result = await media.processRecording(takeFile, cleaned, { prompt: promptFile, lead, maxSeconds: 2.9 })
    expect(result.echo).not.toBeNull()
    expect(Math.abs((result.echo?.delay ?? 0) - (lead + 0.09))).toBeLessThan(0.01)
    expect(result.duration).toBeLessThanOrEqual(2.9)
    const samples = await media.decodePcm(cleaned, RATE)
    const onset = speechBounds(samples, RATE)?.onset ?? 0
    expect(Math.abs(onset + RECORDING_OFFSET - promptOnset)).toBeLessThan(0.04)
    expect(await leftover(cleaned)).toBeLessThan(8)

    // The same take without echo cancellation still holds the original line.
    const plain = path.join(dir, 'plain.m4a')
    await media.processRecording(takeFile, plain, { prompt: promptFile, lead, maxSeconds: 2.9, guide: false })
    expect(await leftover(plain)).toBeGreaterThan(15)
  }, 120_000)
})
