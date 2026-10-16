import { describe, expect, it } from 'vitest'
import type { CatalogItem, ModDetails, ModFile } from '@mcv/shared'
import { chooseFile, pickRandomPack, type RandomCatalog } from '../src/rooms/random-pack.js'

const MB = 1024 * 1024

function item(id: number, name: string): CatalogItem {
  return {
    id,
    name,
    submitter: 'someone',
    category: 'Dub Mode',
    thumbnailUrl: null,
    profileUrl: `https://gamebanana.com/mods/${id}`,
    dateAdded: 0,
    dateModified: 0,
    likes: 0,
    views: 0,
    rated: false,
    version: '',
  }
}

function file(id: number, size: number, downloads = 0, isArchive = true): ModFile {
  return { id, name: `f${id}.zip`, size, description: '', downloads, isArchive }
}

function fakeCatalog(items: CatalogItem[], files: Record<number, ModFile[]>): RandomCatalog & { lookups: number[] } {
  const lookups: number[] = []
  return {
    lookups,
    matching: (keyword) =>
      items.filter((entry) => keyword.split(' ').every((token) => entry.name.toLowerCase().includes(token.toLowerCase()))),
    details: async (modId) => {
      lookups.push(modId)
      return { id: modId, name: items.find((entry) => entry.id === modId)?.name ?? '', files: files[modId] ?? [] } as ModDetails
    },
  }
}

const base = { unusable: new Set<number>(), currentModId: null, maxBytes: 100 * MB }

describe('chooseFile', () => {
  it('takes the most downloaded archive within the limit', () => {
    const files = [file(1, 50 * MB, 5), file(2, 500 * MB, 99), file(3, 10 * MB, 20), file(4, 1 * MB, 100, false)]
    expect(chooseFile(files, 100 * MB)?.id).toBe(3)
    expect(chooseFile([file(2, 500 * MB)], 100 * MB)).toBeNull()
    expect(chooseFile([file(5, 358, 50)], 100 * MB)).toBeNull()
  })
})

describe('pickRandomPack', () => {
  const items = [item(1, 'Shrek swamp'), item(2, 'Shrek 2 dinner'), item(3, 'SpongeBob krabs'), item(4, 'Hazbin hotel')]
  const files = { 1: [file(11, MB)], 2: [file(21, MB)], 3: [file(31, MB)], 4: [file(41, MB)] }

  it('picks a pack that matches a keyword and skips played packs', async () => {
    const catalog = fakeCatalog(items, files)
    const result = await pickRandomPack({ ...base, keywords: ['shrek'], catalog, played: new Set([1]), random: () => 0 })
    expect(result).toEqual({ ok: true, pick: { modId: 2, fileId: 21, name: 'Shrek 2 dinner', keyword: 'shrek', matches: 2 } })
  })

  it('uses played packs again when nothing else matches, but not the current pack', async () => {
    const catalog = fakeCatalog(items, files)
    const result = await pickRandomPack({
      ...base,
      keywords: ['shrek'],
      catalog,
      played: new Set([1, 2]),
      currentModId: 1,
      random: () => 0,
    })
    expect(result.ok && result.pick.modId).toBe(2)
  })

  it('gives each keyword the same chance and picks from all packs without keywords', async () => {
    const catalog = fakeCatalog(items, files)
    const spongebob = await pickRandomPack({ ...base, keywords: ['shrek', 'krabs'], catalog, played: new Set(), random: () => 0.99 })
    expect(spongebob.ok && spongebob.pick).toMatchObject({ modId: 3, keyword: 'krabs', matches: 1 })
    const any = await pickRandomPack({ ...base, keywords: [], catalog, played: new Set(), random: () => 0.99 })
    expect(any.ok && any.pick).toMatchObject({ modId: 4, keyword: null, matches: 4 })
  })

  it('skips packs without a file within the limit and reports missing matches', async () => {
    const catalog = fakeCatalog(items, { ...files, 1: [file(12, 500 * MB)] })
    const unusable = new Set<number>()
    const result = await pickRandomPack({ ...base, unusable, keywords: ['shrek'], catalog, played: new Set(), random: () => 0 })
    expect(result.ok && result.pick.modId).toBe(2)
    expect(unusable.has(1)).toBe(true)
    expect(await pickRandomPack({ ...base, keywords: ['zelda'], catalog, played: new Set() })).toEqual({
      ok: false,
      reason: 'no-matches',
    })
    expect(await pickRandomPack({ ...base, keywords: [], catalog: fakeCatalog([], {}), played: new Set() })).toEqual({
      ok: false,
      reason: 'empty-catalog',
    })
  })
})
