# Rooms, game modes, queue, and voting

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against b97112a
**Code:** `apps/server/src/rooms/room-service.ts`, `apps/server/src/util/ids.ts`, `packages/shared/src/types.ts`, `packages/shared/src/logic.ts`, `apps/web/src/room`

## Room persistence, reconnect, and host transfer

`RoomService` owns rooms, token hashes, connections, progress, and asset readiness.
Rooms have five-character codes using letters and digits without 0, O, 1, I, or L.
The limit is 12 seats and names up to 24 characters.
The browser stores its room token in sessionStorage. The server stores the token's hash.
Joining with the same case-insensitive disconnected name reclaims the seat and replaces its token.
A new player outside the lobby starts as a spectator.

Changes schedule an atomic `rooms.json` save after two seconds.
Restart reloads rooms, pauses active playback, clears transient connections, and resets unfinished exports.
Queued imports that were not ready are restarted when necessary.
The host chooses settings and packs, assigns characters, manages the queue, removes players, and transfers the host role.
After a host disconnects for 60 seconds, the first other connected player becomes the host.

The room sweep runs every 10 minutes.
Empty rooms expire after ROOM_IDLE_HOURS (default 6) and lose their recordings.
At MAX_ROOMS (default 300), a forced sweep can remove empty rooms older than 10 minutes.

## Settings and round assignments

Defaults are Versus, original audio for missing takes, hidden recording video, and no backward line navigation.
The keys are `mode`, `fillMissingWithOriginal`, `showSceneWhileRecording`, and `allowGoingBack`.
The host can change mode, scene visibility, or backward navigation only in lobby or results.
Changing the missing-take setting is not restricted to those phases.

`startRound` uses connected non-spectators and removes the previous round's room media.
`buildDubs` constructs assignments:

| Mode | Assignments |
| --- | --- |
| Versus | One dub per player; that player records every line. |
| Cast | One shared dub; each line goes to its first assigned character, otherwise the first player. |
| Chaos | One shared dub; shuffled lines go to the player with the lowest accumulated workload. |

`autoCast` fills unassigned characters while retaining valid host assignments.
Late players can join a recording round only in Versus.

## Round phases and finish rules

Phases are lobby, recording, playback, voting, and results.
A player must record every assigned line before `finishRecording`.
After finishing, the player cannot upload another take.
Automatic playback begins when all players still present with assignments are marked finished.
A disconnected seat still present can keep the round waiting.
Removing that player removes this wait.
The host cannot move an unfinished recording round directly to playback.

Returning to recording from playback or results clears finish marks but retains takes.
Returning to lobby clears the round, playback, and votes.
See [recording and playback](recording.md) for take processing and synchronized playback.

## Suggestions, queue, keywords, and cancel

Members can add up to 30 suggestions and 20 keywords of at most 40 characters each.
Keyword input accepts comma-separated values.
Only the host uses or queues suggestions. The author or host can remove a suggestion.
Only the host adds, uses, or removes queue entries; the limit is 10.
Queue imports start immediately through the shared processing job limit.
Using a suggestion or queue entry from results returns to the lobby.

Suggestions, queue entries, keywords, and played mod IDs are saved with the room.
Played history keeps at most 500 mod IDs.
Canceling or replacing an import stops its job only when no room or queue still needs it.
See [packs](packs.md) for retries, processing, and random selection.

## Voting and results

Voting requires at least two dubs.
A player cannot vote for their own dub.
A new vote replaces that player's previous vote.
Other players' chosen dubs are hidden during voting.
When every connected player has voted, the room enters results.
Versus results order vote ties by waveform match score.
Cast and Chaos results show player match scores.
Score calculation is documented in [recording](recording.md).
