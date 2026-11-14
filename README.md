# Multiplayer Choicer Voicer

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Players and contributors
**Last verified:** 2026-11-14 against 5ad56e9
**Code:** `apps/web/src/App.tsx`, `apps/server/src/main.ts`, `package.json`, `Dockerfile`

Choicer Voicer Party lets friends dub Choicer Voicer packs in a browser room, watch the result, and vote.
It is an unofficial fan project, not affiliated with The Choicer Voicer's creators.

**Live site: <https://choicervoicer.throndir.com>**

## Documentation map

Start with [docs/README.md](docs/README.md). It maps the current implementation to source paths.
Agents must search the local repo-kb knowledge base before repository exploration.

- [KB contract](docs/kb.md): How do contributors search, verify, and update the docs?
- [Architecture](docs/architecture.md): Where are startup, routes, sockets, and shared contracts?
- [Packs](docs/packs.md): How do catalog search, imports, processing, and pack versions work?
- [Rooms](docs/rooms.md): How do game modes, queue entries, rounds, and votes work?
- [Recording](docs/recording.md): How do microphone capture, timing, playback, scores, and exports work?
- [Browser](docs/browser.md): How do screens, downloads, and private storage work?
- [Development](docs/development.md): Which commands, tools, environment keys, and local checks are supported?
- [Deployment](docs/deployment.md): How do releases and rollbacks on Nahida work?

## Quick start

Use Node.js 20.11 or later, npm, ffmpeg, ffprobe, and bsdtar (tar on Windows).
Run these commands from the repository root:

```powershell
npm ci
npm run dev
```

Vite listens at <http://localhost:5173> and proxies requests to the server at port 3000.
See [development](docs/development.md) for overrides and local checks.
The repository uses npm workspaces: packages/shared, apps/server, and apps/web.
No hosted CI is used.
