import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { SCORE_SAMPLE_RATE, matchScore } from '@mcv/shared'
import { loadConfig } from '../src/config.js'
import { findPackDirs, readPack } from '../src/packs/discover.js'
import { processPackPhaseA, processPackPhaseB } from '../src/packs/processor.js'
import { autoCast, buildDubs, gamePackFolder } from '../src/rooms/room-service.js'
import { Media, runCommand } from '../src/util/media.js'
import { speechBounds } from '../src/util/take.js'
import { writeZip } from '../src/util/zip.js'
import { RATE, addAt, noise, scaleTo, voice } from './synthetic.js'

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
    expect(manifest.lines.map((line) => line.file)).toEqual(raw.lines.map((line) => line.name))
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
    const { duration: seconds } = await media.processRecording(path.join(outDir, 'lines', 'L001.mp3'), recording)
    // 0.15 s lead-in + 1.6 s tone + 0.25 s tail. The tone stays where it is in the upload.
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

    // A take in the recording format of the game: 16-bit PCM, stereo, 44.1 kHz, with the plain 44-byte header.
    const gameWav = path.join(work, 'game.wav')
    await media.audioToGameWav(recording, gameWav)
    const header = readFileSync(gameWav)
    expect(header.toString('ascii', 0, 4)).toBe('RIFF')
    expect(header.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect(header.readUInt32LE(16)).toBe(16)
    expect(header.readUInt16LE(20)).toBe(1)
    expect(header.readUInt16LE(22)).toBe(2)
    expect(header.readUInt32LE(24)).toBe(44100)
    expect(header.readUInt16LE(34)).toBe(16)
    expect(header.toString('ascii', 36, 40)).toBe('data')
    expect(header.readUInt32LE(40)).toBe(header.length - 44)

    const zip = path.join(work, 'takes.zip')
    const takeName = `${gamePackFolder({ folder: 'Group/Sample: Pack.', title: 'x' })}/2026-10-16 22-19-45/_dubrecord_${manifest.lines[0]?.file}.wav`
    await writeZip(
      zip,
      [
        { name: 'README.txt', data: Buffer.from('read me') },
        { name: takeName, file: gameWav },
      ],
      new Date('2026-10-16T22:19:45Z'),
    )
    const listing = await runCommand(loadConfig().archiveTool, ['-tf', zip])
    expect(listing.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['README.txt', takeName])
    expect(takeName.startsWith('Group/Sample_ Pack/')).toBe(true)
    const extracted = path.join(work, 'unzipped')
    mkdirSync(extracted, { recursive: true })
    await media.extractArchive(zip, extracted)
    expect(readFileSync(path.join(extracted, ...takeName.split('/'))).equals(header)).toBe(true)
    expect(gamePackFolder({ folder: '', title: 'My: Pack' })).toBe('My_ Pack')

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

  it('keeps the timing of a browser take', async () => {
    const media = new Media(loadConfig())
    const config = loadConfig()
    const dir = path.join(work, 'timing')
    mkdirSync(dir, { recursive: true })
    const lead = 1.5
    // The upload: the lead in loud noise, then the player (0.45 s after the start of the line, with a pause).
    const upload = noise(Math.round((lead + 2.9) * RATE), 0.006, 12)
    addAt(upload, scaleTo(voice(2.3, 12, [[0.9, 1.4]]), 0.1), lead + 0.45)
    const encode = async (samples: Float32Array, name: string, codec: string[]) => {
      const raw = path.join(dir, `${name}.f32`)
      writeFileSync(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
      const output = path.join(dir, name)
      await runCommand(config.ffmpeg, ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', raw, ...codec, output])
      return output
    }
    const takeFile = await encode(upload, 'take.webm', ['-c:a', 'libopus', '-b:a', '128k'])

    const cleaned = path.join(dir, 'cleaned.m4a')
    const result = await media.processRecording(takeFile, cleaned, { lead, maxSeconds: 2.9 })
    expect(result.duration).toBeLessThanOrEqual(2.9)
    const samples = await media.decodePcm(cleaned, RATE)
    const onset = speechBounds(samples, RATE)?.onset ?? 0
    expect(Math.abs(onset - 0.45)).toBeLessThan(0.05)
  }, 120_000)
})
