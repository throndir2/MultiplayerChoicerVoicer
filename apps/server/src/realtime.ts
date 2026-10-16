import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import type { z } from 'zod'
import type { FastifyBaseLogger } from 'fastify'
import {
  ClientEvents,
  ServerEvents,
  assetStatusSchema,
  castAssignSchema,
  dubExportSchema,
  entryTargetSchema,
  keywordAddSchema,
  keywordRemoveSchema,
  packSelectSchema,
  phaseSetSchema,
  playbackControlSchema,
  playerTargetSchema,
  progressUpdateSchema,
  settingsUpdateSchema,
  socketAuthSchema,
  spectateSchema,
  voteSchema,
  type Ack,
  type AssetStatus,
  type JobView,
  type ProgressView,
} from '@mcv/shared'
import { RoomError, type RoomService } from './rooms/room-service.js'

interface SocketData {
  code: string
  playerId: string
}

type AckFn = (response: Ack & Record<string, unknown>) => void

const roomChannel = (code: string) => `room:${code}`
const playerChannel = (playerId: string) => `player:${playerId}`

export function attachRealtime(httpServer: HttpServer, rooms: RoomService, log: FastifyBaseLogger): Server {
  const io = new Server(httpServer, {
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 20_000,
    pingTimeout: 25_000,
  })

  const pending = new Set<string>()
  let flushScheduled = false

  async function flush(): Promise<void> {
    flushScheduled = false
    const codes = [...pending]
    pending.clear()
    for (const code of codes) {
      const sockets = await io.in(roomChannel(code)).fetchSockets()
      for (const socket of sockets) {
        const data = socket.data as SocketData
        try {
          socket.emit(ServerEvents.state, rooms.view(code, data.playerId))
        } catch {
          socket.emit(ServerEvents.closed)
        }
      }
    }
  }

  function scheduleState(code: string): void {
    pending.add(code)
    if (!flushScheduled) {
      flushScheduled = true
      setImmediate(() => void flush().catch((error) => log.warn({ err: error }, 'state broadcast failed')))
    }
  }

  rooms.on('state', (code: string) => scheduleState(code))
  rooms.on('progress', (code: string, playerId: string, progress: ProgressView) => {
    io.to(roomChannel(code)).emit(ServerEvents.progress, { playerId, progress })
  })
  rooms.on('assets', (code: string, playerId: string, assets: AssetStatus) => {
    io.to(roomChannel(code)).emit(ServerEvents.assets, { playerId, assets })
  })
  rooms.on('job', (code: string, job: JobView) => {
    io.to(roomChannel(code)).emit(ServerEvents.job, job)
  })
  rooms.on('video', (code: string, packId: string, progress: number) => {
    io.to(roomChannel(code)).emit(ServerEvents.video, { packId, progress })
  })
  rooms.on('kicked', (code: string, playerId: string) => {
    io.to(playerChannel(playerId)).emit(ServerEvents.kicked)
    io.in(playerChannel(playerId)).disconnectSockets(true)
    void code
  })
  rooms.on('closed', (code: string) => {
    io.to(roomChannel(code)).emit(ServerEvents.closed)
    io.in(roomChannel(code)).disconnectSockets(true)
  })

  io.use((socket, next) => {
    try {
      const auth = socketAuthSchema.parse(socket.handshake.auth)
      const playerId = rooms.authenticate(auth.code, auth.token)
      if (!playerId) {
        next(new Error('unauthorized'))
        return
      }
      socket.data = { code: auth.code, playerId } satisfies SocketData
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })

  io.on('connection', (socket: Socket) => {
    const { code, playerId } = socket.data as SocketData
    void socket.join(roomChannel(code))
    void socket.join(playerChannel(playerId))
    rooms.connect(code, playerId)

    function command<S extends z.ZodTypeAny>(
      event: string,
      schema: S,
      handler: (payload: z.infer<S>) => unknown,
    ): void {
      socket.on(event, async (payload: unknown, ack?: AckFn) => {
        try {
          const parsed = schema.parse(payload ?? {})
          const result = await handler(parsed)
          ack?.({ ok: true, ...(result && typeof result === 'object' ? result : {}) })
        } catch (error) {
          const message =
            error instanceof RoomError
              ? error.message
              : error instanceof Error && error.name === 'ZodError'
                ? 'Invalid request'
                : 'Something went wrong'
          if (!(error instanceof RoomError)) log.warn({ err: error, event }, 'socket command failed')
          ack?.({ ok: false, error: message })
        }
      })
    }

    socket.on(ClientEvents.timeSync, (_payload: unknown, ack?: AckFn) => ack?.({ ok: true, now: Date.now() }))

    command(ClientEvents.settingsUpdate, settingsUpdateSchema, (patch) => {
      const clean: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) if (value !== undefined) clean[key] = value
      rooms.updateSettings(code, playerId, clean)
    })
    command(ClientEvents.packSelect, packSelectSchema, ({ packId }) => rooms.selectPack(code, playerId, packId))
    command(ClientEvents.jobCancel, playerTargetSchema.partial(), () => rooms.cancelJob(code, playerId))
    command(ClientEvents.suggestionUse, entryTargetSchema, ({ id }) => rooms.useSuggestion(code, playerId, id))
    command(ClientEvents.suggestionQueue, entryTargetSchema, ({ id }) => rooms.queueSuggestion(code, playerId, id))
    command(ClientEvents.suggestionRemove, entryTargetSchema, ({ id }) => rooms.removeSuggestion(code, playerId, id))
    command(ClientEvents.queueUse, entryTargetSchema, ({ id }) => rooms.useQueueEntry(code, playerId, id))
    command(ClientEvents.queueRemove, entryTargetSchema, ({ id }) => rooms.removeQueueEntry(code, playerId, id))
    command(ClientEvents.keywordAdd, keywordAddSchema, ({ text }) => rooms.addKeywords(code, playerId, text))
    command(ClientEvents.keywordRemove, keywordRemoveSchema, ({ keyword }) =>
      rooms.removeKeyword(code, playerId, keyword),
    )
    command(ClientEvents.castAssign, castAssignSchema, ({ character, playerId: target }) =>
      rooms.castAssign(code, playerId, character, target),
    )
    command(ClientEvents.castAuto, playerTargetSchema.partial(), () => rooms.castAuto(code, playerId))
    command(ClientEvents.roundStart, playerTargetSchema.partial(), () => rooms.startRound(code, playerId))
    command(ClientEvents.roundJoin, playerTargetSchema.partial(), () => rooms.joinRound(code, playerId))
    command(ClientEvents.roundFinish, playerTargetSchema.partial(), () => rooms.finishRecording(code, playerId))
    command(ClientEvents.phaseSet, phaseSetSchema, ({ phase }) => rooms.setPhase(code, playerId, phase))
    command(ClientEvents.playerKick, playerTargetSchema, ({ playerId: target }) => rooms.kick(code, playerId, target))
    command(ClientEvents.playerSpectate, spectateSchema, ({ spectator }) =>
      rooms.setSpectator(code, playerId, spectator),
    )
    command(ClientEvents.hostTransfer, playerTargetSchema, ({ playerId: target }) =>
      rooms.transferHost(code, playerId, target),
    )
    command(ClientEvents.playbackControl, playbackControlSchema, ({ action, dubId, position }) =>
      rooms.playbackControl(code, playerId, action, dubId, position),
    )
    command(ClientEvents.voteCast, voteSchema, ({ dubId }) => rooms.vote(code, playerId, dubId))
    command(ClientEvents.dubExport, dubExportSchema, ({ dubId, format, timezoneOffset }) =>
      rooms.exportDub(code, playerId, dubId, format, timezoneOffset),
    )

    socket.on(ClientEvents.progressUpdate, (payload: unknown) => {
      const parsed = progressUpdateSchema.safeParse(payload)
      if (parsed.success) rooms.updateProgress(code, playerId, parsed.data)
    })
    socket.on(ClientEvents.assetsUpdate, (payload: unknown) => {
      const parsed = assetStatusSchema.safeParse(payload)
      if (parsed.success) rooms.updateAssets(code, playerId, parsed.data)
    })

    socket.on('disconnect', () => rooms.disconnect(code, playerId))
  })

  return io
}
