import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Gives the owner read, write and search permission on every folder (and read and write
 * permission on every file) below `root`. Archives can contain read-only folders, and a
 * read-only folder blocks the removal of the files in it. Best effort: errors are ignored.
 */
export async function makeTreeWritable(root: string): Promise<void> {
  let stat
  try {
    stat = await fs.lstat(root)
  } catch {
    return
  }
  if (stat.isFile()) {
    if ((stat.mode & 0o600) !== 0o600) await fs.chmod(root, stat.mode | 0o600).catch(() => undefined)
    return
  }
  if (!stat.isDirectory()) return
  if ((stat.mode & 0o700) !== 0o700) await fs.chmod(root, stat.mode | 0o700).catch(() => undefined)
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isFile()) await makeTreeWritable(path.join(root, entry.name))
  }
}

export async function removeDir(target: string): Promise<void> {
  // A read-only folder blocks the removal of its files, so fix the permissions first.
  await makeTreeWritable(target)
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3 })
}

/** Writes JSON through a temporary file so a crash never leaves a half-written file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value))
  await fs.rename(temp, file)
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

export async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) result.push(full)
    }
  }
  await visit(root)
  return result
}

export async function dirSize(root: string): Promise<number> {
  if (!(await exists(root))) return 0
  let total = 0
  for (const file of await walkFiles(root)) {
    total += (await fs.stat(file)).size
  }
  return total
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

/** Keeps only safe path segments: no drive letters, no `..`, no empty parts. */
export function safeRelativePath(input: string): string | null {
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..' || part.includes(':'))) return null
  const cleaned = parts.map((part) => part.replace(/[<>"|?*\x00-\x1f]/g, '_'))
  return cleaned.join('/')
}

/** Runs async work over items with a fixed number of workers. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}
