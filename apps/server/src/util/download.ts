import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

export interface DownloadOptions {
  allowedHosts: string[]
  maxBytes: number
  userAgent: string
  expectedSize?: number
  onProgress?: (received: number, total: number) => void
}

export interface DownloadResult {
  bytes: number
  fileName: string
  contentType: string
}

export function isHostAllowed(url: URL, allowedHosts: string[]): boolean {
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

function fileNameFrom(response: Response, url: URL): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition)
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  const raw = star?.[1] ?? plain?.[1]
  if (raw) {
    try {
      return decodeURIComponent(raw.trim())
    } catch {
      return raw.trim()
    }
  }
  const last = url.pathname.split('/').filter(Boolean).pop()
  return last ? decodeURIComponent(last) : 'download.bin'
}

/** Downloads a file and follows redirects only to allowed hosts. */
export async function downloadToFile(
  source: string,
  destination: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  let current = new URL(source)
  for (let hop = 0; hop < 8; hop += 1) {
    if (!isHostAllowed(current, options.allowedHosts)) {
      throw new Error(`Downloads from ${current.hostname} are not allowed`)
    }
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': options.userAgent, accept: '*/*' },
      signal: AbortSignal.timeout(60 * 60_000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('Redirect without a location')
      current = new URL(location, current)
      continue
    }
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length')) || 0
    if (declared > options.maxBytes) throw new Error('The file is larger than the download limit')
    const total = declared || options.expectedSize || 0
    let received = 0
    let lastReport = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > options.maxBytes) {
          callback(new Error('The file is larger than the download limit'))
          return
        }
        const now = Date.now()
        if (options.onProgress && now - lastReport > 250) {
          lastReport = now
          options.onProgress(received, total)
        }
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(destination),
    )
    options.onProgress?.(received, total || received)
    return {
      bytes: received,
      fileName: fileNameFrom(response, current),
      contentType: response.headers.get('content-type') ?? '',
    }
  }
  throw new Error('Too many redirects')
}
