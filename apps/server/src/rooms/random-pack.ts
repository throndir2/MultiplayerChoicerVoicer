import type { CatalogItem, ModDetails, ModFile } from '@mcv/shared'

export interface RandomCatalog {
  /** Catalog items that match one keyword. An empty keyword matches every item. Rated items are not included. */
  matching(keyword: string): CatalogItem[]
  details(modId: number): Promise<ModDetails>
}

export interface RandomPackOptions {
  keywords: string[]
  catalog: RandomCatalog
  /** Mods that this room already played or picked. Used again only when no other pack matches. */
  played: ReadonlySet<number>
  /** Mods without a usable file. Never picked. */
  unusable: Set<number>
  /** The mod of the current pack. Never picked again, unless it is the only match. */
  currentModId: number | null
  maxBytes: number
  random?: () => number
  /** Number of mods whose files the server reads before it stops. */
  attempts?: number
}

export interface RandomPick {
  modId: number
  fileId: number
  name: string
  keyword: string | null
  matches: number
}

export type RandomPackResult =
  | { ok: true; pick: RandomPick }
  | { ok: false; reason: 'empty-catalog' | 'no-matches' | 'no-usable-file' }

/** A real pack has a video, so a smaller archive is only a note or a link. */
export const MIN_PACK_BYTES = 100 * 1024

/** The archive file that most players downloaded, within the size limit. */
export function chooseFile(files: ModFile[], maxBytes: number): ModFile | null {
  return (
    files
      .filter((file) => file.isArchive && file.size >= MIN_PACK_BYTES && file.size <= maxBytes)
      .sort((a, b) => b.downloads - a.downloads)[0] ?? null
  )
}

/**
 * Picks a random GameBanana pack. First a random keyword (so that each keyword has the same chance), then a random
 * pack that matches it. Packs that the room already played are skipped while other packs match.
 */
export async function pickRandomPack(options: RandomPackOptions): Promise<RandomPackResult> {
  const random = options.random ?? Math.random
  const attempts = options.attempts ?? 6
  const keywords = options.keywords.length > 0 ? options.keywords : ['']
  const groups = keywords
    .map((keyword) => {
      const items = options.catalog.matching(keyword).filter((item) => !options.unusable.has(item.id))
      return { keyword: keyword || null, items, total: items.length }
    })
    .filter((group) => group.items.length > 0)
  if (groups.length === 0) return { ok: false, reason: options.keywords.length > 0 ? 'no-matches' : 'empty-catalog' }

  const avoid = new Set(options.played)
  if (options.currentModId !== null) avoid.add(options.currentModId)
  const fresh = groups.map((group) => ({ ...group, items: group.items.filter((item) => !avoid.has(item.id)) }))
  const notCurrent = groups.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.id !== options.currentModId),
  }))
  const pool = [fresh, notCurrent, groups].find((candidate) => candidate.some((group) => group.items.length > 0)) ?? groups
  const tried = new Set<number>()

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const open = pool
      .map((group) => ({ ...group, items: group.items.filter((item) => !tried.has(item.id)) }))
      .filter((group) => group.items.length > 0)
    const group = open[Math.floor(random() * open.length)]
    if (!group) break
    const item = group.items[Math.floor(random() * group.items.length)]
    if (!item) break
    tried.add(item.id)
    const details = await options.catalog.details(item.id).catch(() => null)
    if (!details) continue
    const file = chooseFile(details.files, options.maxBytes)
    if (!file) {
      options.unusable.add(item.id)
      continue
    }
    return {
      ok: true,
      pick: { modId: item.id, fileId: file.id, name: details.name, keyword: group.keyword, matches: group.total },
    }
  }
  return { ok: false, reason: 'no-usable-file' }
}
