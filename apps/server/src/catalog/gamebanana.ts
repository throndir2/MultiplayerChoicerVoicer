import type { CatalogItem, ModDetails, ModFile } from '@mcv/shared'

export const GAMEBANANA_GAME_ID = 20674
export const GAMEBANANA_DUB_CATEGORY_ID = 44064
export const GAMEBANANA_HOSTS = ['gamebanana.com', 'files.gamebanana.com', 'images.gamebanana.com']
const API = 'https://gamebanana.com/apiv11'
const ARCHIVE_PATTERN = /\.(zip|7z|rar|tar|tgz|gz)$/i

interface GbImage {
  _sBaseUrl?: string
  _sFile?: string
  _sFile220?: string
  _sFile530?: string
}

interface GbRecord {
  _idRow: number
  _sName?: string
  _sProfileUrl?: string
  _tsDateAdded?: number
  _tsDateModified?: number
  _aPreviewMedia?: { _aImages?: GbImage[] }
  _aSubmitter?: { _sName?: string }
  _aRootCategory?: { _sName?: string }
  _aSubCategory?: { _sName?: string }
  _sVersion?: string
  _bHasContentRatings?: boolean
  _nLikeCount?: number
  _nViewCount?: number
  _sInitialVisibility?: string
}

interface GbIndex {
  _aMetadata?: { _nRecordCount?: number; _bIsComplete?: boolean; _nPerpage?: number }
  _aRecords?: GbRecord[]
}

interface GbFile {
  _idRow: number
  _sFile?: string
  _nFilesize?: number
  _sDescription?: string
  _nDownloadCount?: number
}

interface GbProfile extends GbRecord {
  _sDescription?: string
  _sText?: string
  _aFiles?: GbFile[]
  _nDownloadCount?: number
  _aGame?: { _idRow?: number }
}

function imageUrl(image: GbImage | undefined, size: '220' | '530' | 'full'): string | null {
  if (!image?._sBaseUrl || !image._sFile) return null
  const file =
    size === '220' ? (image._sFile220 ?? image._sFile) : size === '530' ? (image._sFile530 ?? image._sFile) : image._sFile
  return `${image._sBaseUrl}/${file}`
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function toCatalogItem(record: GbRecord): CatalogItem {
  return {
    id: record._idRow,
    name: record._sName ?? `Mod ${record._idRow}`,
    submitter: record._aSubmitter?._sName ?? 'Unknown',
    category: record._aSubCategory?._sName ?? record._aRootCategory?._sName ?? 'Dub Mode',
    thumbnailUrl: imageUrl(record._aPreviewMedia?._aImages?.[0], '220'),
    profileUrl: record._sProfileUrl ?? `https://gamebanana.com/mods/${record._idRow}`,
    dateAdded: record._tsDateAdded ?? 0,
    dateModified: record._tsDateModified ?? record._tsDateAdded ?? 0,
    likes: record._nLikeCount ?? 0,
    views: record._nViewCount ?? 0,
    rated: Boolean(record._bHasContentRatings),
    version: record._sVersion ?? '',
  }
}

export class GameBananaClient {
  constructor(private readonly userAgent: string) {}

  private async getJson<T>(url: string): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': this.userAgent, accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        })
        if (response.status === 404) throw new Error('GameBanana returned 404')
        if (!response.ok) throw new Error(`GameBanana returned HTTP ${response.status}`)
        return (await response.json()) as T
      } catch (error) {
        lastError = error
        if (error instanceof Error && error.message.includes('404')) break
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
      }
    }
    throw lastError instanceof Error ? lastError : new Error('GameBanana request failed')
  }

  async listPage(page: number, perPage = 50): Promise<{ items: CatalogItem[]; total: number; complete: boolean }> {
    const url =
      `${API}/Mod/Index?_nPerpage=${perPage}&_nPage=${page}` +
      `&_aFilters%5BGeneric_Category%5D=${GAMEBANANA_DUB_CATEGORY_ID}&_sSort=Generic_Newest`
    const json = await this.getJson<GbIndex>(url)
    const records = json._aRecords ?? []
    return {
      items: records.filter((record) => record._sInitialVisibility !== 'hide').map(toCatalogItem),
      total: json._aMetadata?._nRecordCount ?? 0,
      complete: Boolean(json._aMetadata?._bIsComplete) || records.length < perPage,
    }
  }

  async modDetails(modId: number): Promise<ModDetails> {
    const profile = await this.getJson<GbProfile>(`${API}/Mod/${modId}/ProfilePage`)
    const files: ModFile[] = (profile._aFiles ?? []).map((file) => ({
      id: file._idRow,
      name: file._sFile ?? `file-${file._idRow}`,
      size: file._nFilesize ?? 0,
      description: file._sDescription ?? '',
      downloads: file._nDownloadCount ?? 0,
      isArchive: ARCHIVE_PATTERN.test(file._sFile ?? ''),
    }))
    return {
      id: profile._idRow ?? modId,
      name: profile._sName ?? `Mod ${modId}`,
      submitter: profile._aSubmitter?._sName ?? 'Unknown',
      description: profile._sDescription ?? '',
      text: stripHtml(profile._sText ?? '').slice(0, 4000),
      profileUrl: profile._sProfileUrl ?? `https://gamebanana.com/mods/${modId}`,
      images: (profile._aPreviewMedia?._aImages ?? [])
        .map((image) => imageUrl(image, '530'))
        .filter((value): value is string => Boolean(value))
        .slice(0, 8),
      files,
      likes: profile._nLikeCount ?? 0,
      views: profile._nViewCount ?? 0,
      downloads: profile._nDownloadCount ?? 0,
    }
  }

  downloadUrl(fileId: number): string {
    return `https://gamebanana.com/dl/${fileId}`
  }
}

/** Reads a mod id from `https://gamebanana.com/mods/123456` style links. */
export function parseGameBananaModUrl(input: string): number | null {
  try {
    const url = new URL(input)
    if (!/(^|\.)gamebanana\.com$/i.test(url.hostname)) return null
    const match = /\/mods\/(\d+)/.exec(url.pathname)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}
