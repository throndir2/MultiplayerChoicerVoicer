import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readPack } from '../src/packs/discover.js'

const work = mkdtempSync(path.join(tmpdir(), 'mcv-discover-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('readPack', () => {
  it('reads line files with the .ini extension', async () => {
    writeFileSync(path.join(work, '_pack_info.ini'), '[data]\n\ntitle="Wallet"\nicon="Icon.png"\n')
    writeFileSync(path.join(work, 'dub_video.ogv'), '')
    writeFileSync(
      path.join(work, '01bob.ini'),
      '[data]\n\ncaption="Ready?"\nimage="bob.png"\ndub_timestamps=[0.494]\ndub_characters=["Spongebob"]\n',
    )
    writeFileSync(path.join(work, '01bob.ogg'), '')
    writeFileSync(path.join(work, 'bob.png'), '')

    const raw = await readPack(work)
    expect(raw.title).toBe('Wallet')
    expect(raw.lines).toHaveLength(1)
    expect(raw.lines[0]).toMatchObject({ name: '01bob', caption: 'Ready?', characters: ['Spongebob'] })
    expect(raw.lines[0]?.audioPath).toBe(path.join(work, '01bob.ogg'))
  })
})
