import path from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  createRoomRequestSchema,
  joinRoomRequestSchema,
  roomCodeSchema,
  sourceRequestSchema,
  uploadCreateSchema,
} from '@mcv/shared'
import type { CatalogService, CatalogSort } from './catalog/catalog-service.js'
import type { AppConfig } from './config.js'
import { PACK_ID_PATTERN, type PackService } from './packs/pack-service.js'
import { RoomError, type RoomService } from './rooms/room-service.js'
import type { UploadService } from './rooms/uploads.js'

export interface AppDeps {
  config: AppConfig
  catalog: CatalogService
  packs: PackService
  rooms: RoomService
  uploads: UploadService
}

const catalogQuerySchema = z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  sort: z.enum(['new', 'updated', 'likes', 'views', 'name']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(60).optional(),
  hideRated: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

const recordingQuerySchema = z.object({
  dubId: z.string().min(1).max(64),
  lineId: z.string().min(1).max(16),
})

const chunkQuerySchema = z.object({
  path: z.string().min(1).max(400),
  offset: z.coerce.number().int().min(0),
})

const IMMUTABLE = 'public, max-age=31536000, immutable'

export async function registerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config, catalog, packs, rooms, uploads } = deps

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  )
  app.addContentTypeParser(
    /^(audio|video)\/.*/,
    { parseAs: 'buffer', bodyLimit: 30 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  )

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RoomError) return reply.code(error.status).send({ error: error.message })
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request' })
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) app.log.error({ err: error }, 'request failed')
    const message = error instanceof Error ? error.message : 'Request failed'
    return reply.code(status).send({ error: status >= 500 ? 'Something went wrong' : message })
  })

  function authenticate(request: FastifyRequest, code: string): string {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const playerId = token ? rooms.authenticate(code, token) : null
    if (!playerId) throw new RoomError('You are not in this room', 401)
    return playerId
  }

  const codeParams = z.object({ code: roomCodeSchema })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/api/catalog', async (request) => {
    const query = catalogQuerySchema.parse(request.query)
    return catalog.search({
      ...(query.q ? { q: query.q } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.sort ? { sort: query.sort as CatalogSort } : {}),
      ...(query.page ? { page: query.page } : {}),
      ...(query.pageSize ? { pageSize: query.pageSize } : {}),
      hideRated: query.hideRated,
    })
  })

  app.get('/api/catalog/mods/:id', async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params)
    try {
      return await catalog.details(id)
    } catch {
      throw new RoomError('GameBanana did not return that mod', 502)
    }
  })

  app.get('/api/packs', async () => ({ packs: packs.listRecent() }))

  app.get('/api/packs/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().regex(PACK_ID_PATTERN) }).parse(request.params)
    const manifest = packs.manifest(id)
    if (!manifest) throw new RoomError('Unknown pack', 404)
    reply.header('cache-control', 'no-cache')
    return manifest
  })

  app.post('/api/rooms', async (request, reply) => {
    const body = createRoomRequestSchema.parse(request.body)
    return reply.code(201).send(await rooms.createRoom(body.name))
  })

  app.get('/api/rooms/:code', async (request) => {
    const { code } = codeParams.parse(request.params)
    return rooms.info(code)
  })

  app.post('/api/rooms/:code/players', async (request, reply) => {
    const { code } = codeParams.parse(request.params)
    const body = joinRoomRequestSchema.parse(request.body)
    return reply.code(201).send(rooms.joinRoom(code, body.name))
  })

  app.post('/api/rooms/:code/source', async (request) => {
    const { code } = codeParams.parse(request.params)
    const playerId = authenticate(request, code)
    const body = sourceRequestSchema.parse(request.body)
    return { job: await rooms.selectSource(code, playerId, body) }
  })

  app.post('/api/rooms/:code/suggestions', async (request, reply) => {
    const { code } = codeParams.parse(request.params)
    const playerId = authenticate(request, code)
    const body = sourceRequestSchema.parse(request.body)
    const suggestion = await rooms.addSuggestion(code, playerId, body)
    return reply.code(201).send({ id: suggestion.id })
  })

  app.post('/api/rooms/:code/queue', async (request, reply) => {
    const { code } = codeParams.parse(request.params)
    const playerId = authenticate(request, code)
    const body = sourceRequestSchema.parse(request.body)
    const entry = await rooms.addToQueue(code, playerId, body)
    return reply.code(201).send({ id: entry.id })
  })

  app.post('/api/rooms/:code/recordings', async (request) => {
    const { code } = codeParams.parse(request.params)
    const playerId = authenticate(request, code)
    const query = recordingQuerySchema.parse(request.query)
    if (!Buffer.isBuffer(request.body)) throw new RoomError('Send the recording as audio data')
    const recording = await rooms.addRecording(
      code,
      playerId,
      query.dubId,
      query.lineId,
      request.body,
      request.headers['content-type'] ?? '',
    )
    return { recording }
  })

  app.post('/api/rooms/:code/uploads', async (request, reply) => {
    const { code } = codeParams.parse(request.params)
    const playerId = authenticate(request, code)
    const body = uploadCreateSchema.parse(request.body)
    const uploadId = await uploads.create(code, playerId, body.files, body.public)
    return reply.code(201).send({ uploadId })
  })

  const uploadParams = z.object({ code: roomCodeSchema, id: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/) })

  app.get('/api/rooms/:code/uploads/:id', async (request) => {
    const { code, id } = uploadParams.parse(request.params)
    const playerId = authenticate(request, code)
    return uploads.status(uploads.get(id, code, playerId))
  })

  app.put('/api/rooms/:code/uploads/:id/chunk', async (request) => {
    const { code, id } = uploadParams.parse(request.params)
    const playerId = authenticate(request, code)
    const query = chunkQuerySchema.parse(request.query)
    if (!Buffer.isBuffer(request.body)) throw new RoomError('Send the chunk as application/octet-stream')
    const upload = uploads.get(id, code, playerId)
    return { received: await uploads.writeChunk(upload, query.path, query.offset, request.body) }
  })

  app.post('/api/rooms/:code/uploads/:id/complete', async (request) => {
    const { code, id } = uploadParams.parse(request.params)
    const playerId = authenticate(request, code)
    const upload = uploads.get(id, code, playerId)
    const done = uploads.complete(upload)
    const job = packs.requestUpload({
      uploadId: id,
      dir: done.dir,
      label: done.label,
      uploader: rooms.playerName(code, playerId),
      public: done.public,
    })
    return { job: rooms.attachUploadJob(code, playerId, job) }
  })

  if (config.webRoot) {
    await app.register(fastifyStatic, {
      root: config.webRoot,
      prefix: '/',
      index: ['index.html'],
      setHeaders: (response, filePath) => {
        const relative = path.relative(config.webRoot ?? '', filePath)
        response.setHeader(
          'cache-control',
          relative.startsWith('assets') ? IMMUTABLE : 'no-cache',
        )
      },
    })
  }

  await app.register(fastifyStatic, {
    root: path.join(config.dataDir, 'media'),
    prefix: '/media/',
    decorateReply: false,
    index: false,
    list: false,
    cacheControl: false,
    setHeaders: (response, filePath) => {
      response.setHeader('cache-control', filePath.endsWith('manifest.json') ? 'no-cache' : IMMUTABLE)
      response.setHeader('access-control-allow-origin', '*')
    },
  })

  app.setNotFoundHandler((request, reply) => {
    const url = request.url
    const isApi = url.startsWith('/api/') || url.startsWith('/media/') || url.startsWith('/socket.io')
    if (request.method === 'GET' && !isApi && config.webRoot) {
      reply.header('cache-control', 'no-cache')
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({ error: 'Not found' })
  })
}
