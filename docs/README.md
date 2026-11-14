# Knowledge base map

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against b97112a
**Code:** `packages/shared/src`, `apps/server/src`, `apps/web/src`, `deploy`, `scripts`, `Dockerfile`, `package.json`

Use local `repo-kb` search to find a page. Read its cited section, then follow its Code paths.
The pages describe the current code. A Planned section describes work that is not built.

## Pages

- [Knowledge base contract](kb.md): How must agents search, verify, and maintain these pages?
- [Architecture](architecture.md): Where are startup, HTTP routes, socket commands, and shared contracts?
- [Packs](packs.md): How do catalog search, imports, uploads, processing, random selection, and versions work?
- [Rooms](rooms.md): Who owns rooms, assignments, phases, suggestions, queue entries, and votes?
- [Recording](recording.md): How do microphone capture, waveform, take timing, playback, scoring, and exports work?
- [Browser](browser.md): Where are screens, asset downloads, readiness, cache, and deletion implemented?
- [Development](development.md): Which local commands, tests, tools, and environment keys are supported?
- [Deployment](deployment.md): How does a contributor release or roll back the service on Nahida?
- [Superseded design](plan.md): Where should older design links point now?

## Code areas

| Question | Folder |
| --- | --- |
| Which types, schemas, events, captions, cues, and scores do both applications use? | `packages/shared/src` |
| Where does the server start and read its configuration? | `apps/server/src/main.ts`, `apps/server/src/config.ts` |
| Where are HTTP routes and socket commands registered? | `apps/server/src/app.ts`, `apps/server/src/realtime.ts` |
| How is the GameBanana library searched and refreshed? | `apps/server/src/catalog` |
| How are packs found, parsed, converted, reused, and removed? | `apps/server/src/packs` |
| Who owns rooms, assignments, votes, recordings, exports, and uploads? | `apps/server/src/rooms` |
| Where are media commands and file operations? | `apps/server/src/util` |
| Where are the home and room screens? | `apps/web/src/screens` |
| Where are the lobby, recording, playback, vote, and results views? | `apps/web/src/room` |
| Where are browser storage, downloads, audio, microphone, and connection helpers? | `apps/web/src/lib` |
| Where are reusable controls and styles? | `apps/web/src/components`, `apps/web/src/styles.css` |
| Where are local checks and build settings? | `package.json`, `apps/server/test`, `packages/shared/test`, `apps/web/vite.config.ts` |
| Where are the container and release scripts? | `Dockerfile`, `deploy`, `scripts` |
