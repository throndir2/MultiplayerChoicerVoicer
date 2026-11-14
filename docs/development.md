# Local development, configuration, and checks

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against b97112a
**Code:** `package.json`, `package-lock.json`, `tsconfig.base.json`, `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/tsup.config.ts`, `apps/server/src/config.ts`, `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `scripts/make-sample-pack.mjs`, `apps/server/test`, `packages/shared/test`, `.gitignore`, `.dockerignore`

## Requirements and development server

Node.js 20.11 or later and npm are required by the root package.
Media operations need ffmpeg, ffprobe, and bsdtar (Windows uses tar by default).
The sample pack also needs the Theora, Vorbis, and MP3 encoders.
Install dependencies with `npm ci` from the repository root.
`npm run dev` starts the server and Vite through concurrently.
The default server port is 3000; Vite uses 5173.
Vite proxies `/api`, `/media`, `/healthz`, and `/socket.io`.
`MCV_SERVER` overrides Vite's server target, default `http://localhost:3000`.
Microphone capture needs a secure browser context, such as HTTPS or localhost.

## Commands and test locations

Run commands from the repository root.

| Command | Result |
| --- | --- |
| `npm run dev` | Runs tsx watch for the server and Vite for the client. |
| `npm run typecheck` | Runs workspace TypeScript checks. |
| `npm test` | Runs shared and server Vitest tests; the pipeline uses ffmpeg. No web test runner is configured. |
| `npm run build` | Builds server output with tsup and client output with TypeScript and Vite. |
| `npm start` | Runs `apps/server/dist/main.js`; WEB_ROOT enables client serving. |
| `npm run sample-pack` | Regenerates `data/sample/Sample Pack` and its ZIP. |
| `npm run docker:build` | Builds the local image with Docker. |

The server build target is node20. The container uses node:22-alpine.
Output folders are `apps/server/dist` and `apps/web/dist`.
Shared tests cover captions, cues, recording order, versions, and scoring.
Server tests cover parsing, discovery, pack processing, take cleanup, random selection, versions, and temporary cleanup.

The sample generator accepts an optional output directory after its script name.
It replaces its Sample Pack subfolder. Do not point it at a folder with wanted sample edits.
It reads FFMPEG_PATH and ARCHIVE_TOOL.
See [deployment](deployment.md) for release commands and [KB contract](kb.md) for local search.

## Server environment variables

`loadConfig` in `apps/server/src/config.ts` reads these values once at startup.
Numeric values must be finite numbers; the loader does not impose bounds on all tuning values.
DATA_DIR is resolved from INIT_CWD, or the current directory when INIT_CWD is absent.

| Key | Default | Meaning |
| --- | --- | --- |
| HOST | `0.0.0.0` | Listen address. |
| PORT | `3000` | Listen port. |
| DATA_DIR | `data` under the invocation directory | JSON state and media. |
| WEB_ROOT | unset | Built client folder; unset means no client serving. |
| TRUST_PROXY | `false` | Only the literal `true` enables proxy trust. |
| LOG_LEVEL | `info` | Fastify log level. |
| FFMPEG_PATH | `ffmpeg` | Audio and video tool. |
| FFPROBE_PATH | `ffprobe` | Media probe tool. |
| ARCHIVE_TOOL | `tar` on Windows, `bsdtar` elsewhere | Archive extraction tool. |
| VIDEO_MAX_HEIGHT | `720` | Maximum pack video height. |
| VIDEO_CRF | `27` | Video quality factor. |
| VIDEO_PRESET | `veryfast` | x264 preset. |
| FFMPEG_THREADS | `0` | ffmpeg thread count; 0 delegates selection. |
| PACK_CACHE_MAX_GB | `20` | Cache limit, multiplied by 1024 cubed. |
| DOWNLOAD_MAX_MB | `2048` | Download limit, multiplied by 1024 squared. |
| UPLOAD_MAX_MB | `2048` | Upload limit, multiplied by 1024 squared. |
| CATALOG_SYNC | `true` | Only the literal `false` disables synchronization. |
| CATALOG_REFRESH_HOURS | `6` | Full refresh interval. |
| IMPORT_ALLOWED_HOSTS | list in config.ts | Comma-separated lower-case allowed hosts. |
| ROOM_IDLE_HOURS | `6` | Empty-room expiry. |
| MAX_ROOMS | `300` | Room limit before forced cleanup. |
| USER_AGENT | `MultiplayerChoicerVoicer/0.1 (+https://github.com/throndir2/MultiplayerChoicerVoicer)` | Remote download and catalog request identity. |

Default import hosts cover GameBanana, GitHub content, Dropbox, Google Drive, and Discord media.
See the exact list in config.ts; see [packs](packs.md) for redirect checks.
Compose exposes only the tuning keys listed in [deployment](deployment.md).
