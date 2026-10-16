import { z } from 'zod'
import { MAX_KEYWORDS, MAX_KEYWORD_LENGTH, MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from './types.js'

export const displayNameSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(MAX_NAME_LENGTH))

export const roomCodeSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.string().length(ROOM_CODE_LENGTH).regex(/^[A-Z0-9]+$/))

export const createRoomRequestSchema = z.object({ name: displayNameSchema })
export const joinRoomRequestSchema = z.object({ name: displayNameSchema })

export const gameModeSchema = z.enum(['versus', 'cast', 'chaos'])
export const roomPhaseSchema = z.enum(['lobby', 'recording', 'playback', 'voting', 'results'])

export const settingsUpdateSchema = z
  .object({
    mode: gameModeSchema,
    fillMissingWithOriginal: z.boolean(),
    showSceneWhileRecording: z.boolean(),
    allowGoingBack: z.boolean(),
  })
  .partial()

export const sourceRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gamebanana'),
    modId: z.number().int().positive(),
    fileId: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('url'), url: z.string().url().max(2000) }),
  z.object({ kind: z.literal('pack'), packId: z.string().min(1).max(80) }),
  /** A random GameBanana pack that matches one of the room keywords. */
  z.object({ kind: z.literal('random') }),
])
export type SourceRequest = z.infer<typeof sourceRequestSchema>

/** Splits typed text into keywords at commas, semicolons and new lines. Removes duplicates (case-insensitive). */
export function parseKeywords(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of text.split(/[,;\n]/)) {
    const keyword = part.replace(/\s+/g, ' ').trim().slice(0, MAX_KEYWORD_LENGTH).trim()
    const key = keyword.toLowerCase()
    if (!keyword || seen.has(key)) continue
    seen.add(key)
    result.push(keyword)
  }
  return result
}

export const keywordAddSchema = z.object({ text: z.string().min(1).max(MAX_KEYWORDS * (MAX_KEYWORD_LENGTH + 2)) })
export const keywordRemoveSchema = z.object({ keyword: z.string().min(1).max(MAX_KEYWORD_LENGTH * 2) })

export const packSelectSchema = z.object({ packId: z.string().min(1).max(80) })
export const entryTargetSchema = z.object({ id: z.string().min(1).max(32) })
export const castAssignSchema = z.object({
  character: z.string().min(1).max(200),
  playerId: z.string().max(64).nullable(),
})
export const phaseSetSchema = z.object({ phase: roomPhaseSchema })
export const playerTargetSchema = z.object({ playerId: z.string().min(1).max(64) })
export const spectateSchema = z.object({ spectator: z.boolean() })
export const playbackControlSchema = z.object({
  action: z.enum(['play', 'pause', 'seek', 'select', 'stop']),
  dubId: z.string().max(64).optional(),
  position: z.number().min(0).max(36_000).optional(),
})
export const voteSchema = z.object({ dubId: z.string().min(1).max(64) })
export const dubTargetSchema = z.object({ dubId: z.string().min(1).max(64) })

export const progressUpdateSchema = z.object({
  dubId: z.string().max(64).nullable(),
  lineId: z.string().max(16).nullable(),
  recording: z.boolean(),
})

export const assetStatusSchema = z.object({
  packId: z.string().max(80).nullable(),
  lines: z.number().min(0).max(1),
  backing: z.number().min(0).max(1),
  video: z.number().min(0).max(1),
  recordings: z.number().min(0).max(1),
  ready: z.boolean(),
})

export const uploadCreateSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(400),
        size: z.number().int().min(0),
        /** File time from the browser (ms). A folder upload keeps the dates of the pack files with it. */
        lastModified: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(2000),
  public: z.boolean().default(false),
})

export const socketAuthSchema = z.object({
  code: roomCodeSchema,
  token: z.string().min(16).max(128),
})
