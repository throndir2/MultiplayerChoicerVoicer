import Fastify, { LogController } from 'fastify'
import { registerRoutes } from './app.js'
import { CatalogService } from './catalog/catalog-service.js'
import { GameBananaClient } from './catalog/gamebanana.js'
import { loadConfig } from './config.js'
import { PackService } from './packs/pack-service.js'
import { attachRealtime } from './realtime.js'
import { RoomService } from './rooms/room-service.js'
import { UploadService } from './rooms/uploads.js'
import { ensureDir } from './util/fsx.js'
import { Media } from './util/media.js'

const config = loadConfig()
const app = Fastify({
  logger: { level: config.logLevel },
  logController: new LogController({ disableRequestLogging: true }),
  trustProxy: config.trustProxy,
  bodyLimit: 1024 * 1024,
})

await ensureDir(config.dataDir)
const media = new Media(config)
const missing = await media.checkTools()
if (missing.length > 0) {
  app.log.error({ missing }, 'media tools are missing; pack processing and recordings will fail')
}

const gamebanana = new GameBananaClient(config.userAgent)
const catalog = new CatalogService(config, gamebanana, app.log)
await catalog.load()
const packs = new PackService(config, media, gamebanana, app.log)
await packs.load()
const rooms = new RoomService(config, packs, catalog, media, app.log)
await rooms.load()
const uploads = new UploadService(config)
await uploads.load()

await registerRoutes(app, { config, catalog, packs, rooms, uploads })
const io = attachRealtime(app.server, rooms, app.log)

await app.listen({ host: config.host, port: config.port })
catalog.start()

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'shutting down')
  catalog.stop()
  uploads.stop()
  await rooms.shutdown()
  await packs.flush()
  io.close()
  await app.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
