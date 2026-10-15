import { UPLOAD_CHUNK_BYTES, type JobView, type UploadStatusResponse } from '@mcv/shared'
import { api, ApiError, uploadBinary } from './api'

export interface UploadItem {
  file: File
  path: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Uploads files in 8 MB chunks. A failed chunk is retried from the byte that the server has. */
export async function uploadPack(
  code: string,
  token: string,
  items: UploadItem[],
  isPublic: boolean,
  onProgress: (fraction: number) => void,
): Promise<JobView | null> {
  const { uploadId } = await api<{ uploadId: string }>(`/api/rooms/${code}/uploads`, {
    body: { files: items.map((item) => ({ path: item.path, size: item.file.size })), public: isPublic },
    token,
  })
  const total = items.reduce((sum, item) => sum + item.file.size, 0) || 1
  let finished = 0
  for (const item of items) {
    let offset = 0
    let failures = 0
    while (offset < item.file.size) {
      const chunk = item.file.slice(offset, offset + UPLOAD_CHUNK_BYTES)
      const query = `path=${encodeURIComponent(item.path)}&offset=${offset}`
      try {
        const { received } = await uploadBinary<{ received: number }>(
          `/api/rooms/${code}/uploads/${uploadId}/chunk?${query}`,
          chunk,
          token,
          'application/octet-stream',
        )
        offset = received
        failures = 0
      } catch (error) {
        failures += 1
        if (failures > 10 || (error instanceof ApiError && error.status !== 409 && error.status < 500)) throw error
        await sleep(Math.min(20_000, 1000 * 2 ** failures))
        try {
          const status = await api<UploadStatusResponse>(`/api/rooms/${code}/uploads/${uploadId}`, { token })
          offset = status.files.find((file) => file.path === item.path)?.received ?? offset
        } catch {
          // Keep the old offset and try again.
        }
      }
      onProgress((finished + offset) / total)
    }
    finished += item.file.size
  }
  const { job } = await api<{ job: JobView | null }>(`/api/rooms/${code}/uploads/${uploadId}/complete`, {
    method: 'POST',
    body: {},
    token,
  })
  return job
}
