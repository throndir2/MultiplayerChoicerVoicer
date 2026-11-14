# Pack catalog, imports, processing, and versions

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against b97112a
**Code:** `apps/server/src/catalog`, `apps/server/src/packs`, `apps/server/src/rooms/random-pack.ts`, `apps/server/src/rooms/uploads.ts`, `apps/server/src/util/download.ts`, `apps/server/src/util/fsx.ts`, `apps/server/src/util/media.ts`, `packages/shared/src/logic.ts`, `apps/server/test`

## GameBanana catalog and search

`GameBananaClient` uses apiv11, Dub Mode category 44064, and game constant 20674.
The list request uses `/Mod/Index`, 50 records per page, the category filter, and Generic_Newest sorting.
Details use `/Mod/<id>/ProfilePage`; downloads use `https://gamebanana.com/dl/<fileId>`.
Categories are counted from the local items. The code does not call a Categories endpoint.
`CatalogService` loads `catalog.json`, refreshes fully every CATALOG_REFRESH_HOURS (default 6), and checks three pages every 20 minutes.
An empty or stale catalog starts a full refresh. A current catalog starts a quick refresh.
Refresh errors are logged and retain available entries.

Search matches every whitespace-separated word in the name, submitter, category, or mod ID.
The API supports `q`, `category`, `sort`, `page`, `pageSize`, and `hideRated`.
Sort values are new, updated, likes, views, and name. The default page size is 24; the maximum is 60.
Mod details are cached for 10 minutes with at most 500 entries.

## Sources, upload chunks, and direct links

Sources are a GameBanana mod/file, a direct URL, a processed pack ID, or a random choice.
An upload can contain an archive or a folder.
Archive discovery accepts zip, 7z, rar, tar, tgz, and gz.
Direct downloads require HTTPS, no URL credentials, and an allowed host or its subdomain.
Every redirect is checked too. The download loop permits up to eight request hops.
The download byte limit is enforced on declared size and received bytes.
This host check is not a general guarantee about every host's resolved IP address.

`UploadService` keeps incomplete uploads in memory and DATA_DIR/uploads.
The client sends 8 MiB chunks and asks the server for the received offsets after a failed chunk.
Offsets cannot skip bytes or exceed a file's size.
Completion requires every byte; folder file times are restored from `lastModified` when available.
Uploads do not survive a server restart: `load` removes the unfinished upload folder.
The sweep removes uploads older than 24 hours.

## Pack discovery and Godot configuration

`findPackDirs` searches to depth 8, preferring folders with `_pack_info.ini`.
If none exist, folders with `dub_video.ogv` are accepted.
`readPack` reads Godot ConfigFile-style `[data]` sections through `parseGodotConfig`.
Metadata fields include title, subtitle, authors, readme, and icon.
Line files use `.txt` or `.ini`, with caption, image, dub_timestamps, and dub_characters.
Lines without timestamps are ignored. No video or no usable lines fails the pack.
Video, audio, and image fallbacks are defined in `discover.ts`.
Lines sort by first timestamp, then numeric file name. Each timestamp reuses that line's recording.

## Two-phase processing and cache

`PackService` runs at most two import jobs and one pack video conversion at a time.
It extracts with the configured archive tool and tries nested archives if it finds no pack.
It rejects extracted data larger than four times the download limit.
Temporary job folders are removed; cleanup failures are logged.

`processPackPhaseA` probes the video and creates the material needed for recording.
Line images become JPEGs with maximum width 640. A missing image is taken from the video when possible.
Existing MP3 prompts are copied. Other prompt formats are converted to mono MP3 and measured with ffprobe.
The icon uses maximum width 660. Existing MP3 backing audio is copied; other formats are converted.
Failed optional images or audio yield null URLs. The manifest keeps original line file names and pack folder paths.

Output is DATA_DIR/media/packs/<packId>, containing `manifest.json`, images, prompts, backing audio, and later `video.mp4`.
`processPackPhaseB` converts the video to H.264 with faststart and configurable maximum height (default 720).
Recording can start before phase B completes. Video errors appear in the manifest.
The source video folder is removed after successful conversion.

`packs-index.json` stores last-use times and ready jobs, not unfinished processing jobs.
Eviction removes least-recently-used packs above PACK_CACHE_MAX_GB.
Packs used by rooms or queues, and packs currently converting video, are skipped.
The cache can therefore remain above its configured limit.

## Fingerprints and pack version detection

`fingerprintPack` hashes immediate regular files, excluding `.DS_Store`, `Thumbs.db`, and `desktop.ini`.
It includes lower-case names, sizes, and contents. It does not recursively hash subfolders.
`builtAt` is the newest file time when the date is plausible; otherwise it is null.
Identical hashes reuse a processed pack and can retry a failed video conversion.
The source can become more public: GameBanana, URL, public upload, then private upload.

`packVersionKey` groups normalized title and author names.
It removes version numbers, accents, punctuation, and trailing version words.
Versions sort by builtAt, or createdAt when builtAt is absent.
`listRecent` lists public sources; `versions` also includes the current pack, even if it is private.
Old manifests without hashes are not deduplicated by content.
Old manifests without line names cannot export game WAVs until matching files restore those names.

## Random pack from keywords

`pickRandomPack` chooses a matching keyword, then a random pack in that group.
Rated and known unusable mods are excluded.
It first avoids played and current mods, then permits played mods, then permits the current mod if necessary.
It checks at most six mods for the most-downloaded archive between 100 KiB and the download limit.
`RoomService` retries failed random import jobs automatically at most three times per button press.
Random selection is a source choice, not a game mode.
See [rooms](rooms.md) for keyword, suggestion, and queue limits.

## Tests

`apps/server/test` covers Godot parsing, discovery, the pack pipeline, versions, random selection, and temporary cleanup.
`packages/shared/test/shared.test.ts` covers title normalization and cue behavior.
