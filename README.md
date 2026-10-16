# Multiplayer Choicer Voicer

Choicer Voicer Party is a website where a group of friends dubs [The Choicer Voicer](https://gamebanana.com/games/20674) packs together. One player creates a room and sends the link. The players record their lines in the browser, then watch the result together with subtitles, and vote.

**Live site: <https://choicervoicer.throndir.com>**

This is an unofficial fan project. It is not affiliated with the creators of The Choicer Voicer.

## Features

- **Rooms**: a 5-character code and an invite link (`/join/CODE`). The host chooses the pack and the mode, and can remove players or give the host role to another player.
- **Pack library**: the server keeps a searchable copy of the GameBanana "Dub Mode" list. Players can also paste a GameBanana or direct link, or upload a `.zip`, `.7z`, `.rar` archive or a pack folder (resumable upload).
- **Random pack from keywords**: every player can add keywords to a shared list. The host gets a random GameBanana pack that matches one of the keywords, and can re-roll. Packs that the room already played are skipped.
- **Game modes**:
  - **Versus**: everybody dubs the whole pack, then you watch every dub and vote.
  - **Cast**: the host gives characters to players (or uses auto-cast), and everybody watches one shared dub.
  - **Chaos**: lines are shuffled and shared at random.
- **Recording**: the line image, the caption, the original line, a live waveform of the microphone compared with the original, "play in the scene", and keyboard shortcuts. "Record" starts the recording at once. The server cuts the part before the line, puts the first word where the original line has it, and normalises the loudness.
- **Progress**: each player sees the progress bar, the current line and the scene of the other players.
- **Playback**: synchronised start on every device, Web Audio scheduling, the video follows the audio clock, subtitles with the character and the voice actor.
- **Export**: any dub can be exported to MP4 with soft subtitles.
- **Smart downloads**: each browser downloads the pack files and the recordings of the other players in the background, in priority order, into the private Cache Storage of the site. Broken downloads continue with HTTP Range requests.

The full design is in [docs/plan.md](docs/plan.md). Deployment is in [docs/deployment.md](docs/deployment.md).

## Development

Requirements:

- Node.js 20.11 or later (the Docker image uses Node 22).
- `ffmpeg` and `ffprobe` on `PATH` (with libx264 and libmp3lame).
- `bsdtar` on Linux and macOS (package `libarchive-tools`). On Windows, the built-in `tar.exe` is bsdtar.

```powershell
npm install
npm run dev
```

`npm run dev` starts the server on port 3000 and Vite on <http://localhost:5173>. Vite forwards `/api`, `/media` and `/socket.io` to the server. Data goes to `./data`.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Builds the server (`apps/server/dist`) and the client (`apps/web/dist`). |
| `npm start` | Starts the built server. Set `WEB_ROOT=apps/web/dist` to serve the client too. |
| `npm run typecheck` | Type checks all packages. |
| `npm test` | Runs the unit tests and the pack pipeline test (needs ffmpeg). |
| `npm run sample-pack` | Makes `data/sample/Sample Pack.zip`, a small synthetic pack for uploads and tests. |
| `npm run docker:build` | Builds the Docker image. |

## Configuration

The server reads environment variables. The most important ones:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address. |
| `DATA_DIR` | `./data` | Catalog, rooms, pack cache and recordings. |
| `WEB_ROOT` | (none) | Folder of the built client. When set, the server serves the website. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy. |
| `CATALOG_SYNC` | `true` | Set `false` to switch off the GameBanana list sync. |
| `IMPORT_ALLOWED_HOSTS` | GameBanana, GitHub, Dropbox, Google Drive, Discord | Hosts that "Link" imports may download from. |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `ARCHIVE_TOOL` | `ffmpeg`, `ffprobe`, `bsdtar` (`tar` on Windows) | Media tools. |

See [docs/deployment.md](docs/deployment.md) for the tuning variables.

## Repository layout

```text
packages/shared   Types, Zod schemas, socket event names, cue and caption logic
apps/server       Fastify + Socket.IO server, GameBanana catalog, pack processing, rooms
apps/web          React + Vite client
deploy/           Docker Compose file for Nahida
scripts/          Nahida deploy, Nginx Proxy Manager setup and the sample pack generator
docs/             Design plan and deployment guide
```