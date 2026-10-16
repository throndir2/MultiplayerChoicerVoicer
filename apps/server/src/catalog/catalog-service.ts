import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import type { CatalogCategory, CatalogItem, CatalogResponse, ModDetails } from '@mcv/shared'
import type { AppConfig } from '../config.js'
import { readJson, writeJsonAtomic } from '../util/fsx.js'
import { GameBananaClient } from './gamebanana.js'

interface CatalogFile {
  syncedAt: number
  items: CatalogItem[]
}

export type CatalogSort = 'new' | 'updated' | 'likes' | 'views' | 'name'

export interface CatalogQuery {
  q?: string
  category?: string
  sort?: CatalogSort
  page?: number
  pageSize?: number
  hideRated?: boolean
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class CatalogService {
  private items = new Map<number, CatalogItem>()
  private syncedAt: number | null = null
  private syncing = false
  private categories: CatalogCategory[] = []
  private readonly detailsCache = new Map<number, { at: number; value: ModDetails }>()
  private readonly file: string
  private timers: NodeJS.Timeout[] = []

  constructor(
    private readonly config: AppConfig,
    readonly client: GameBananaClient,
    private readonly log: FastifyBaseLogger,
  ) {
    this.file = path.join(config.dataDir, 'catalog.json')
  }

  async load(): Promise<void> {
    const stored = await readJson<CatalogFile>(this.file)
    if (stored?.items) {
      this.items = new Map(stored.items.map((item) => [item.id, item]))
      this.syncedAt = stored.syncedAt
      this.rebuildCategories()
    }
  }

  start(): void {
    if (!this.config.catalogEnabled) return
    const refreshMs = this.config.catalogRefreshHours * 3_600_000
    const stale = !this.syncedAt || Date.now() - this.syncedAt > refreshMs
    if (stale) void this.fullSync()
    else void this.quickSync()
    this.timers.push(setInterval(() => void this.quickSync(), 20 * 60_000))
    this.timers.push(setInterval(() => void this.fullSync(), refreshMs))
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  private rebuildCategories(): void {
    const counts = new Map<string, number>()
    for (const item of this.items.values()) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
    this.categories = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.file, { syncedAt: this.syncedAt ?? Date.now(), items: [...this.items.values()] })
  }

  async fullSync(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    const started = Date.now()
    const fresh = new Map<number, CatalogItem>()
    try {
      for (let page = 1; page <= 1000; page += 1) {
        const result = await this.client.listPage(page)
        for (const item of result.items) fresh.set(item.id, item)
        if (result.complete || result.items.length === 0) break
        // Merge as we go so the library fills up during the first sync.
        if (page % 10 === 0) {
          for (const [id, item] of fresh) this.items.set(id, item)
          this.rebuildCategories()
        }
        await sleep(350)
      }
      this.items = fresh.size > 0 ? fresh : this.items
      this.syncedAt = Date.now()
      this.rebuildCategories()
      await this.save()
      this.log.info({ count: this.items.size, ms: Date.now() - started }, 'catalog full sync complete')
    } catch (error) {
      for (const [id, item] of fresh) this.items.set(id, item)
      this.rebuildCategories()
      this.log.warn({ err: error }, 'catalog full sync failed')
    } finally {
      this.syncing = false
    }
  }

  async quickSync(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      for (let page = 1; page <= 3; page += 1) {
        const result = await this.client.listPage(page)
        for (const item of result.items) this.items.set(item.id, item)
        if (result.complete) break
        await sleep(350)
      }
      this.rebuildCategories()
      await this.save()
    } catch (error) {
      this.log.warn({ err: error }, 'catalog quick sync failed')
    } finally {
      this.syncing = false
    }
  }

  search(query: CatalogQuery): CatalogResponse {
    const pageSize = Math.min(60, Math.max(1, query.pageSize ?? 24))
    const page = Math.max(1, query.page ?? 1)
    const tokens = searchTokens(query.q ?? '')
    let results = [...this.items.values()]
    if (query.category) results = results.filter((item) => item.category === query.category)
    if (query.hideRated) results = results.filter((item) => !item.rated)
    if (tokens.length > 0) results = results.filter((item) => matchesTokens(item, tokens))
    const sort = query.sort ?? 'new'
    const compare: Record<CatalogSort, (a: CatalogItem, b: CatalogItem) => number> = {
      new: (a, b) => b.dateAdded - a.dateAdded,
      updated: (a, b) => b.dateModified - a.dateModified,
      likes: (a, b) => b.likes - a.likes || b.views - a.views,
      views: (a, b) => b.views - a.views,
      name: (a, b) => a.name.localeCompare(b.name),
    }
    results.sort(compare[sort])
    return {
      items: results.slice((page - 1) * pageSize, page * pageSize),
      total: results.length,
      page,
      pageSize,
      categories: this.categories,
      syncedAt: this.syncedAt,
      syncing: this.syncing,
    }
  }

  async details(modId: number): Promise<ModDetails> {
    const cached = this.detailsCache.get(modId)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value
    const value = await this.client.modDetails(modId)
    this.detailsCache.set(modId, { at: Date.now(), value })
    if (this.detailsCache.size > 500) {
      const oldest = [...this.detailsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) this.detailsCache.delete(oldest[0])
    }
    return value
  }

  /** Items without a content rating that match every word of the keyword. An empty keyword matches every item. */
  matching(keyword: string): CatalogItem[] {
    const tokens = searchTokens(keyword)
    return [...this.items.values()].filter((item) => !item.rated && matchesTokens(item, tokens))
  }

  get(modId: number): CatalogItem | undefined {
    return this.items.get(modId)
  }
}

function searchTokens(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

function matchesTokens(item: CatalogItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const haystack = `${item.name} ${item.submitter} ${item.category} ${item.id}`.toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}
