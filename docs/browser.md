# Browser screens, downloads, and private storage

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against b97112a
**Code:** `apps/web/src`, `apps/web/index.html`, `apps/web/public`

## Screens and room connection

`App.tsx` routes `/` and `/join/:code` to HomeScreen, and `/room/:code` to RoomScreen.
Unknown routes show HomeScreen.
HomeScreen creates or joins rooms and opens downloaded-file management.
RoomScreen provides room context and selects the lobby, recording, playback, voting, or results view.
`lib/api.ts` owns HTTP helpers and per-tab room sessions.
`lib/room.ts` owns the socket connection, acknowledgments, state updates, and manifest requests.
`components/ui.tsx` supplies shared controls; `styles.css` supplies styles.
The home and upload screens link to the Choicer Voicer Pack Creator.

## Pack library, queue, and readiness

Library selects catalog entries, recent server packs, links, or uploads.
PackLists displays suggestions and queued packs. RandomPack displays shared keywords and random selection.
ProgressPanel displays each player's line and recording progress.
PlayersPanel displays player roles and host actions.
Server readiness and browser download progress are separate.
Pack manifests identify URLs and byte sizes.
See [packs](packs.md) and [rooms](rooms.md) for server behavior.

## Asset priority and HTTP Range retries

`AssetStore` in `lib/assets.ts` owns the download entries and Cache Storage.
`usePreloader` in `lib/preload.ts` requests current and queued pack media.
Lower numeric priority starts first. At most three downloads run simultaneously.
Priority order includes own lines, icon, other recordings, backing audio, other lines, then video.
Queued packs have lower priority than the current pack and download in queue order.
Playback can request missing audio at a higher priority.
`AssetStatus.ready` requires lines, backing, video, and recordings to be complete.

Failed downloads retry up to eight times.
Partial bytes remain in memory during retries; an HTTP Range request continues from the received offset.
If the server does not return 206, the client restarts from byte zero.
This does not persist a partial download across a page reload.
The video uses the cached blob when available, otherwise the server URL.

## Cache Storage, quota, and deletion

The media cache name is `mcv-media-v1`.
Last-use times are saved under `mcv:asset-index` in localStorage.
At asset-store construction, pruning removes files unused for seven days.
Pruning is not a continuous seven-day timer.
The client requests persistent storage during a round, but the browser can refuse it.
If Cache Storage is unavailable or full, downloaded blobs can remain in memory.
Available disk quota depends on the browser; the code does not guarantee a percentage or size.

StoragePanel lists stored packs and recordings, their sizes, and last-use times.
`lib/storage.ts` groups media paths, remembers pack names, and handles clear-on-leave.
Delete removes cache entries, memory entries, and last-use records, and cancels matching download results.
An open room's preloader requests required media again after deletion.
Clear-on-leave runs on an explicit room exit.
After a closed tab, it runs on the next visit unless the visit returns to that same room.
Pack names use `mcv:pack-names`; the option uses `mcv:clear-on-leave`.

## Recording and playback

See [recording](recording.md) for microphone preparation, count-in, guide audio, waveform, timing, and exports.
DubPlayer follows shared playback state or supplies local controls.
DubDownloads requests server exports and exposes ready download links.
VotingView and ResultsView show dubs and match scores.
