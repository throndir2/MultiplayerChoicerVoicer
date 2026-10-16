import { RECORDING_OFFSET } from './types.js'
import type { DubView, PackLine, PackManifest, PlaybackState, RoomView, RoundView } from './types.js'

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  '“': '”',
  '”': '”',
  '„': '“',
  "'": "'",
  '‘': '’',
  '«': '»',
  '「': '」',
  '『': '』',
}

/** Removes a leading `[Speaker]` tag and one pair of outer quotes from a caption. */
export function cleanCaption(caption: string): string {
  let text = caption.replace(/\r?\n/g, ' ').trim()
  text = text.replace(/^\[[^\]]{0,80}\]\s*[:\-–—]?\s*/, '')
  const first = text.charAt(0)
  const closing = QUOTE_PAIRS[first]
  if (closing && text.length >= 2) {
    const last = text.charAt(text.length - 1)
    if (last === closing || last === first || (first === '“' && last === '"')) {
      text = text.slice(1, -1).trim()
    } else if (!text.slice(1).includes(closing)) {
      text = text.slice(1).trim()
    }
  }
  return text || caption.trim()
}

export interface Cue {
  key: string
  lineId: string
  lineIndex: number
  time: number
  duration: number
  url: string | null
  playerId: string | null
  original: boolean
  text: string
  characters: string[]
}

/** Every audio event of a dub in time order. A line with several timestamps yields several cues. */
export function buildCues(manifest: PackManifest, dub: DubView, fillMissing: boolean): Cue[] {
  const cues: Cue[] = []
  for (const line of manifest.lines) {
    const recording = dub.recordings[line.id]
    const url = recording ? recording.url : fillMissing ? line.promptUrl : null
    const duration = recording ? recording.duration : line.promptDuration
    const offset = recording ? RECORDING_OFFSET : 0
    line.timestamps.forEach((timestamp, index) => {
      cues.push({
        key: `${line.id}:${index}`,
        lineId: line.id,
        lineIndex: line.index,
        time: Math.max(0, timestamp + offset),
        duration: Math.max(duration, 0.1),
        url,
        playerId: recording?.playerId ?? dub.assignments[line.id] ?? null,
        original: !recording,
        text: line.text,
        characters: line.characters,
      })
    })
  }
  return cues.sort((a, b) => a.time - b.time || a.lineIndex - b.lineIndex)
}

/**
 * The order in which a player records lines: all lines of one character together, so the player
 * does not switch voices back and forth. Characters come in order of their first line; the lines
 * of a character keep their pack order. A line with several characters goes with its first character.
 */
export function recordingOrder<T extends Pick<PackLine, 'characters'>>(lines: T[]): T[] {
  const rank = new Map<string, number>()
  for (const line of lines) {
    const key = line.characters[0] ?? ''
    if (!rank.has(key)) rank.set(key, rank.size)
  }
  return lines
    .map((line, index) => ({ line, index, group: rank.get(line.characters[0] ?? '') ?? 0 }))
    .sort((a, b) => a.group - b.group || a.index - b.index)
    .map((entry) => entry.line)
}

/** The cues whose subtitle is visible at `position` seconds. */
export function activeCues(cues: Cue[], position: number): Cue[] {
  return cues.filter((cue) => {
    const end = cue.time + Math.max(cue.duration, 1.2) + 0.3
    return position >= cue.time - 0.05 && position < end
  })
}

/** Playback position in seconds for a server time. */
export function playbackPosition(playback: PlaybackState, serverNow: number): number {
  if (playback.status !== 'playing') return playback.position
  return playback.position + (serverNow - playback.startedAt) / 1000
}

export interface PlayerTaskCount {
  assigned: number
  recorded: number
}

/** How many lines each player must record in the current round, and how many are done. */
export function taskCounts(room: Pick<RoomView, 'round'>): Map<string, PlayerTaskCount> {
  const counts = new Map<string, PlayerTaskCount>()
  for (const dub of room.round?.dubs ?? []) {
    for (const [lineId, playerId] of Object.entries(dub.assignments)) {
      const entry = counts.get(playerId) ?? { assigned: 0, recorded: 0 }
      entry.assigned += 1
      if (dub.recordings[lineId]?.playerId === playerId) entry.recorded += 1
      counts.set(playerId, entry)
    }
  }
  return counts
}

/** The players in the room who have lines in the current round and have not finished recording yet. */
export function unfinishedPlayers(room: { round: RoundView | null; players: { id: string }[] }): string[] {
  const round = room.round
  if (!round) return []
  const present = new Set(room.players.map((player) => player.id))
  const waiting = new Set<string>()
  for (const dub of round.dubs) {
    for (const playerId of Object.values(dub.assignments)) {
      if (present.has(playerId) && !round.finished?.[playerId]) waiting.add(playerId)
    }
  }
  return [...waiting]
}

export function formatSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
