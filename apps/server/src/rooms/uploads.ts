import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { UploadStatusResponse } from '@mcv/shared'
import type { AppConfig } from '../config.js'
import { RoomError } from '../rooms/room-service.js'
import { ensureDir, removeDir, safeRelativePath } from '../util/fsx.js'
import { randomId } from '../util/ids.js'

interface UploadFile {
  path: string
  size: number
  received: number
}

interface UploadRecord {
  id: string
  code: string
  playerId: string
  dir: string
  files: UploadFile[]
  public: boolean
  createdAt: number
  completed: boolean
}

/** Resumable uploads: the client sends 8 MB chunks and can ask how much the server has. */
export class UploadService {
  private readonly uploads = new Map<string, UploadRecord>()
  private readonly root: string
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly config: AppConfig) {
    this.root = path.join(config.dataDir, 'uploads')
  }

  async load(): Promise<void> {
    await removeDir(this.root).catch(() => undefined)
    await ensureDir(this.root)
    this.timer = setInterval(() => void this.sweep(), 30 * 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async create(
    code: string,
    playerId: string,
    files: { path: string; size: number }[],
    isPublic: boolean,
  ): Promise<string> {
    const total = files.reduce((sum, file) => sum + file.size, 0)
    if (total > this.config.uploadMaxBytes) {
      throw new RoomError(`The upload is larger than ${Math.round(this.config.uploadMaxBytes / 1024 ** 2)} MB`)
    }
    const seen = new Set<string>()
    const cleaned: UploadFile[] = []
    for (const file of files) {
      const relative = safeRelativePath(file.path)
      if (!relative || seen.has(relative.toLowerCase())) throw new RoomError(`Invalid file name: ${file.path}`)
      seen.add(relative.toLowerCase())
      cleaned.push({ path: relative, size: file.size, received: 0 })
    }
    const id = randomId(9)
    const dir = path.join(this.root, id)
    await ensureDir(dir)
    for (const file of cleaned) {
      const target = path.join(dir, file.path)
      await ensureDir(path.dirname(target))
      await fs.writeFile(target, Buffer.alloc(0))
    }
    this.uploads.set(id, {
      id,
      code,
      playerId,
      dir,
      files: cleaned,
      public: isPublic,
      createdAt: Date.now(),
      completed: false,
    })
    return id
  }

  get(id: string, code: string, playerId: string): UploadRecord {
    const upload = this.uploads.get(id)
    if (!upload || upload.code !== code || upload.playerId !== playerId) throw new RoomError('Unknown upload', 404)
    return upload
  }

  status(upload: UploadRecord): UploadStatusResponse {
    return { uploadId: upload.id, files: upload.files.map((file) => ({ ...file })) }
  }

  async writeChunk(upload: UploadRecord, filePath: string, offset: number, chunk: Buffer): Promise<number> {
    if (upload.completed) throw new RoomError('The upload is already complete', 409)
    const relative = safeRelativePath(filePath)
    const file = upload.files.find((entry) => entry.path === relative)
    if (!file) throw new RoomError('Unknown file', 404)
    if (offset > file.received) throw new RoomError(`Expected offset ${file.received}`, 409)
    if (offset + chunk.length > file.size) throw new RoomError('The chunk is larger than the file', 400)
    const end = offset + chunk.length
    if (end > file.received) {
      const handle = await fs.open(path.join(upload.dir, file.path), 'r+')
      try {
        await handle.write(chunk, 0, chunk.length, offset)
      } finally {
        await handle.close()
      }
      file.received = end
    }
    return file.received
  }

  /** Marks the upload complete and hands its folder to the caller. */
  complete(upload: UploadRecord): { dir: string; label: string; public: boolean } {
    const missing = upload.files.find((file) => file.received < file.size)
    if (missing) throw new RoomError(`${missing.path} is not completely uploaded`, 409)
    upload.completed = true
    this.uploads.delete(upload.id)
    const first = upload.files[0]?.path ?? 'Upload'
    const label = first.includes('/') ? (first.split('/')[0] ?? first) : first.replace(/\.(zip|7z|rar)$/i, '')
    return { dir: upload.dir, label, public: upload.public }
  }

  private async sweep(): Promise<void> {
    const limit = Date.now() - 24 * 3_600_000
    for (const upload of this.uploads.values()) {
      if (upload.createdAt < limit) {
        this.uploads.delete(upload.id)
        await removeDir(upload.dir).catch(() => undefined)
      }
    }
  }
}
