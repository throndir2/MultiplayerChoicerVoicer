# Architecture, HTTP API, and shared contracts

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against b97112a
**Code:** `apps/server/src/main.ts`, `apps/server/src/app.ts`, `apps/server/src/realtime.ts`, `packages/shared/src`, `apps/web/src/App.tsx`, `apps/web/src/main.tsx`

## Startup and state owners

The npm workspaces are `@mcv/shared`, `@mcv/server`, and `@mcv/web`.
The server uses Fastify and Socket.IO. The client uses React, Vite, and Wouter.
`main.ts` reads configuration, checks media tools, loads the catalog, packs, rooms, and uploads, then registers routes and sockets.
Missing media tools produce a log error. The server still starts.
Catalog synchronization starts after the listener starts.
SIGINT and SIGTERM stop timers, save rooms and the pack index, close sockets, and close Fastify.

`RoomService` owns room state. `PackService` owns manifests and processing jobs.
`CatalogService` owns the searchable catalog. `UploadService` owns unfinished uploads.
Persistence uses JSON files and media folders under DATA_DIR, not a database.
See [rooms](rooms.md), [packs](packs.md), and [development](development.md).

## HTTP API routes and authentication

`registerRoutes` in `app.ts` registers the following routes.
`CODE` denotes a room code; `ID` denotes the route's identifier.

| Method and route | Purpose |
| --- | --- |
| GET `/healthz` | Returns `{status: 'ok'}`; this is not a media-tool readiness check. |
| GET `/api/catalog` | Searches catalog metadata. |
| GET `/api/catalog/mods/ID` | Reads GameBanana mod details. |
| GET `/api/packs` | Lists recent public pack groups and their versions. |
| GET `/api/packs/ID` | Returns a manifest; sends `no-cache`. |
| POST `/api/rooms` | Creates a room and a player token. |
| GET `/api/rooms/CODE` | Returns public room information. |
| POST `/api/rooms/CODE/players` | Joins or reclaims a disconnected name. |
| POST `/api/rooms/CODE/source` | Selects the pack source; host only. |
| POST `/api/rooms/CODE/suggestions` | Adds a member's pack suggestion. |
| POST `/api/rooms/CODE/queue` | Adds a pack to the host's queue. |
| POST `/api/rooms/CODE/recordings` | Uploads an assigned line's audio. |
| POST `/api/rooms/CODE/uploads` | Creates an upload session. |
| GET `/api/rooms/CODE/uploads/ID` | Returns bytes received for each file. |
| PUT `/api/rooms/CODE/uploads/ID/chunk` | Writes a file chunk at an offset. |
| POST `/api/rooms/CODE/uploads/ID/complete` | Hands the completed folder to pack processing. |

Room write routes require `Authorization: Bearer <token>`.
The service applies host, membership, assignment, and phase rules for the operation.
Recording query fields are `dubId`, `lineId`, optional `lead` (0 to 10 seconds), and optional `mic` diagnostics.
Chunk query fields are `path` and `offset`. The body uses `application/octet-stream`.
The binary parser permits 16 MiB; the audio/video parser permits 30 MiB.

Zod schemas reject invalid requests with 400. `RoomError` supplies its status and message.
Unexpected server errors are logged; 5xx responses use `Something went wrong`.

## Socket commands

`attachRealtime` authenticates `code` and `token` from the Socket.IO handshake.
It registers each command explicitly with its shared Zod schema.
`ClientEvents` and `ServerEvents` in `types.ts` are the event-name catalog.
Commands cover settings, packs, suggestions, queue, keywords, cast, rounds, phases, players, playback, votes, and exports.
Acknowledgments return `ok` and an optional error. Time synchronization returns the server time.
Progress and asset updates have separate events; full room state is sent per viewer.
During voting, another player's chosen dub is hidden until results.

## Shared captions, cues, and scores

`types.ts` defines manifests, room views, settings, limits, and event names.
`schemas.ts` validates inputs. `index.ts` exports the shared modules.
`logic.ts` implements `cleanCaption`, `buildCues`, `activeCues`, `recordingOrder`, task counts, and version keys.
Each line timestamp produces one cue. A recorded cue uses RECORDING_OFFSET, currently 0.
Missing recordings use the prompt only when `fillMissingWithOriginal` is true.
Subtitles use cleaned captions and character names.
`score.ts` owns loudness envelopes, match scores, score labels, and per-dub totals.
Shared tests are in `packages/shared/test`.
