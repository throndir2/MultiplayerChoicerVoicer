# Microphone recording, waveform, playback, and exports

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against b97112a
**Code:** `apps/web/src/room/Recorder.tsx`, `apps/web/src/room/RecordingView.tsx`, `apps/web/src/room/DubPlayer.tsx`, `apps/web/src/room/DubDownloads.tsx`, `apps/web/src/room/ResultsView.tsx`, `apps/web/src/lib/audio.ts`, `apps/web/src/lib/microphone.ts`, `apps/web/src/lib/clock.ts`, `apps/server/src/rooms/room-service.ts`, `apps/server/src/util/take.ts`, `apps/server/src/util/media.ts`, `apps/server/src/util/zip.ts`, `packages/shared/src/score.ts`, `packages/shared/src/logic.ts`

## Recording order and original-line playback

`RecordingView` uses `recordingOrder`: lines group by first character, in first-character appearance order.
Lines within a character retain pack order.
Moving to another line plays its original once when the saved autoplay option is enabled.
The first line does not autoplay.
`allowGoingBack` controls previous-line navigation and the line list.
Shortcuts are R for record/stop, P for original, T for take, N for next/finish, and B for previous.

## Immediate record start, count-in, and tail

The microphone opens when the recording view needs it.
The recorder prepares its capture worklet and decodes the prompt before the button press.
The Record button starts on pointer-down; the following click does not stop it.
The R key starts on key-down.
Microphone permission and a working device are still required.

Count-in is saved as `mcv:count-in-seconds`: default 2 seconds, range 0 to 5, step 0.5.
Capture starts before count-in. The scene and guide audio start after count-in.
The lead measures elapsed capture time plus audio output latency.
The client and server cut the lead; it is not part of the saved line.
Guide volume is saved as `mcv:guide-volume`, default 0.3, range 0 to 1.
The scene option uses muted video.

`RECORDING_TAIL_SECONDS` is 0.6. Stop and automatic line end keep this extra capture time.
The server limits a take to prompt duration plus 0.6 plus 0.25 seconds when a prompt duration exists.
The upload includes `lead` and microphone diagnostics.
Raw uploads stay under media/rooms/<roomId>/src for diagnosis.

## Microphone processing and waveform

`useMicrophone` disables echo cancellation.
Noise suppression and automatic gain are off by default and share the saved `mcv:mic-ns` option.
Use headphones when guide audio is enabled.
`Recorder` captures live samples through an AudioWorklet and draws them over the prompt waveform.
Each display column shows sample peaks and an RMS core.
The prompt and saved take scale independently; the live signal uses a stable reference level.
The live time axis excludes the lead.

## Server take cleanup and match score

`Media.processRecording` decodes mono samples at 48 kHz.
`cleanTake` removes the lead and applies a high-pass filter.
Speech detection compares frame levels with the measured noise floor.
It keeps 0.05 seconds before detected speech and 0.2 seconds after it, with short fades.
It keeps the player's timing rather than moving speech to the line start.
Takes with speech use loudnorm and AAC output; takes without detected speech do not use loudnorm.
A successful new take replaces the previous recording and invalidates both export states.

Scoring decodes the take and prompt to 8 kHz mono.
`loudnessEnvelope` uses 20 ms frames with silence trimmed.
`matchEnvelopes` compares shape, rhythm, and duration; rhythm permits up to 100 ms lag.
The score is rounded from `100 * (0.55 * shape + 0.45 * rhythm) * (0.5 + 0.5 * timing)`.
Labels start at 90 (Perfect), 75 (Great), 55 (Good), and 35 (OK).
Unrecorded assignments count as zero in totals. An unavailable score is not a measured zero.

## Synchronized playback and video drift

`syncClock` takes six ping samples and estimates server time from round-trip timing.
The host's play request starts at server time plus PLAYBACK_LEAD_MS, currently 1500.
`DubPlayer` decodes audio locally, schedules backing and cues with Web Audio, and mutes the video.
A late client starts at the elapsed position.
The video follows the audio clock.
Drift above 0.3 seconds triggers a seek; drift above 0.04 seconds adjusts playback rate.
The host can play, pause, seek, stop, or select a dub.
Results can play a dub locally without shared controls.
Subtitles show characters, cleaned captions, and player names.

## MP4 and Choicer Voicer WAV downloads

`exportDub` supports video and game formats through a serialized export chain.
Video export needs the converted pack video. It mixes cues and backing audio and adds soft subtitles.
Game export does not need the converted video, but every line must have its original file name.
The ZIP contains `<pack folder>/<YYYY-MM-DD HH-MM-SS>/_dubrecord_<line>.wav` and a README.
WAV output is 16-bit PCM stereo at 44.1 kHz.
The folder date uses the newest take or round start, adjusted by the browser's timezone offset.
When enabled, missing takes use original prompts.
See `apps/server/test/take.test.ts`, `pipeline.test.ts`, and `packages/shared/test/score.test.ts` for local checks.
