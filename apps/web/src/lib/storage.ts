import { useEffect } from 'react'
import type { RoomView } from '@mcv/shared'
import { assets, type StoredFile } from './assets'

const NAMES_KEY = 'mcv:pack-names'
const CLEAR_ON_LEAVE_KEY = 'mcv:clear-on-leave'
const OPEN_ROOM_KEY = 'mcv:open-room'
const PACKS_PREFIX = '/media/packs/'
const ROOMS_PREFIX = '/media/rooms/'

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Storage full or blocked.
  }
}

function names(): Record<string, string> {
  try {
    return JSON.parse(read(NAMES_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/** Remembers the title of a pack, so the storage panel can show a name instead of an ID. */
export function rememberPackName(id: string, title: string): void {
  const all = names()
  if (all[id] === title) return
  all[id] = title
  write(NAMES_KEY, JSON.stringify(all))
}

export function packName(id: string): string | null {
  return names()[id] ?? null
}

export function clearOnLeave(): boolean {
  return read(CLEAR_ON_LEAVE_KEY) === '1'
}

export function setClearOnLeave(on: boolean): void {
  write(CLEAR_ON_LEAVE_KEY, on ? '1' : null)
}

export interface StoredGroup {
  /** `pack:<id>`, `recordings` or `other`. */
  key: string
  packId: string | null
  size: number
  count: number
  lastUsed: number
  match: (path: string) => boolean
}

/** Groups the stored files by pack. All recordings of other players are one group. */
export function groupStored(files: StoredFile[]): StoredGroup[] {
  const groups = new Map<string, StoredGroup>()
  for (const file of files) {
    let key = 'other'
    let packId: string | null = null
    let match = (path: string) => !path.startsWith(PACKS_PREFIX) && !path.startsWith(ROOMS_PREFIX)
    if (file.path.startsWith(PACKS_PREFIX)) {
      const encoded = file.path.slice(PACKS_PREFIX.length).split('/')[0] ?? ''
      const prefix = `${PACKS_PREFIX}${encoded}/`
      try {
        packId = decodeURIComponent(encoded)
      } catch {
        packId = encoded
      }
      key = `pack:${packId}`
      match = (path: string) => path.startsWith(prefix)
    } else if (file.path.startsWith(ROOMS_PREFIX)) {
      key = 'recordings'
      match = (path: string) => path.startsWith(ROOMS_PREFIX)
    }
    const group = groups.get(key) ?? { key, packId, size: 0, count: 0, lastUsed: 0, match }
    group.size += file.size
    group.count += 1
    group.lastUsed = Math.max(group.lastUsed, file.lastUsed)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.lastUsed - a.lastUsed || b.size - a.size)
}

/** The group keys that the room needs now. */
export function roomInUse(room: RoomView): string[] {
  const keys = new Set<string>()
  if (room.pack) keys.add(`pack:${room.pack.id}`)
  if (room.round) {
    keys.add(`pack:${room.round.packId}`)
    keys.add('recordings')
  }
  return [...keys]
}

let openRooms = 0

/** Records that a room is open, and deletes the files when the player leaves it (if the player chose this). */
export function useLeaveCleanup(code: string): void {
  useEffect(() => {
    openRooms += 1
    write(OPEN_ROOM_KEY, code)
    return () => {
      openRooms -= 1
      window.setTimeout(() => {
        if (openRooms > 0) return
        write(OPEN_ROOM_KEY, null)
        if (clearOnLeave()) void assets.clearAll()
      }, 500)
    }
  }, [code])
}

/**
 * A closed tab cannot delete files. Thus, if the last visit ended in a room, the files go
 * at the next visit, except when the visit goes back into the same room (a reload).
 */
export function cleanupAfterClosedTab(): void {
  const code = read(OPEN_ROOM_KEY)
  if (!code) return
  const path = window.location.pathname.toLowerCase()
  const same = code.toLowerCase()
  if (path === `/room/${same}` || path === `/join/${same}`) return
  write(OPEN_ROOM_KEY, null)
  if (clearOnLeave()) void assets.clearAll()
}
