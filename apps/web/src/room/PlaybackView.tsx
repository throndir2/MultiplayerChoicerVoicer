import { useState } from 'react'
import { ClientEvents, type DubView } from '@mcv/shared'
import { PlayerChip, percent } from '../components/ui'
import { useRoom } from '../lib/room'
import { DubPlayer, type HostControls } from './DubPlayer'

export function dubTitle(dub: DubView, names: Map<string, string>): string {
  if (dub.ownerId) return `${names.get(dub.ownerId) ?? dub.name}'s dub`
  return dub.name === 'Chaos' ? 'The chaos dub' : 'The ensemble dub'
}

export function PlaybackView() {
  const { room, isHost, roundManifest: manifest, command, notify } = useRoom()
  const [watched, setWatched] = useState<Set<string>>(new Set())
  const round = room.round
  const playback = room.playback
  const names = new Map(room.players.map((player) => [player.id, player.name]))

  if (!round || !manifest) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    )
  }
  const dub = round.dubs.find((entry) => entry.id === playback?.dubId) ?? round.dubs[0]
  if (!dub) return null
  const dubIndex = round.dubs.indexOf(dub)
  const nextDub = round.dubs[dubIndex + 1]

  function run(event: string, payload: unknown) {
    void command(event, payload).catch((error: Error) => notify(error.message))
  }

  const hostControls: HostControls | null = isHost
    ? {
        play: (position) =>
          run(ClientEvents.playbackControl, { action: 'play', dubId: dub.id, ...(position !== undefined ? { position } : {}) }),
        pause: () => run(ClientEvents.playbackControl, { action: 'pause', dubId: dub.id }),
        seek: (position) => run(ClientEvents.playbackControl, { action: 'seek', dubId: dub.id, position }),
      }
    : null

  const viewers = room.players.filter((player) => player.connected)

  return (
    <div className="playback">
      <div className="playback__main">
        <div className="section-head">
          <h2>
            {dubTitle(dub, names)}
            {round.dubs.length > 1 && (
              <span className="muted">
                {' '}
                ({dubIndex + 1} of {round.dubs.length})
              </span>
            )}
          </h2>
          {isHost && (
            <div className="button-row">
              {nextDub && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => run(ClientEvents.playbackControl, { action: 'select', dubId: nextDub.id })}
                >
                  Next dub →
                </button>
              )}
              {round.dubs.length > 1 ? (
                <button type="button" className="button" onClick={() => run(ClientEvents.phaseSet, { phase: 'voting' })}>
                  🗳 Go to the vote
                </button>
              ) : (
                <button type="button" className="button" onClick={() => run(ClientEvents.phaseSet, { phase: 'results' })}>
                  Finish
                </button>
              )}
              <button type="button" className="button button--ghost" onClick={() => run(ClientEvents.phaseSet, { phase: 'recording' })}>
                Back to recording
              </button>
            </div>
          )}
        </div>
        <DubPlayer
          key={`${dub.id}:${manifest.videoStatus}`}
          manifest={manifest}
          dub={dub}
          fillMissing={room.settings.fillMissingWithOriginal}
          players={room.players}
          synced={playback}
          hostControls={hostControls}
          onEnded={() => setWatched((current) => new Set(current).add(dub.id))}
        />
        {!isHost && <p className="hint">The host starts and stops the playback for everybody.</p>}
      </div>
      <aside className="playback__side">
        {round.dubs.length > 1 && (
          <section className="card">
            <h3>Dubs</h3>
            <ol className="dub-list">
              {round.dubs.map((entry) => {
                const recorded = Object.keys(entry.recordings).length
                const total = Object.keys(entry.assignments).length
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`dub-list__item${entry.id === dub.id ? ' is-current' : ''}`}
                      disabled={!isHost}
                      onClick={() => run(ClientEvents.playbackControl, { action: 'select', dubId: entry.id })}
                    >
                      <span>{dubTitle(entry, names)}</span>
                      <span className="muted">
                        {recorded}/{total} lines{watched.has(entry.id) ? ' · watched' : ''}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </section>
        )}
        <section className="card">
          <h3>Ready to watch</h3>
          <ul className="ready-list">
            {viewers.map((player) => {
              const assets = player.assets && player.assets.packId === round.packId ? player.assets : null
              return (
                <li key={player.id}>
                  <PlayerChip name={player.name} color={player.color} small />
                  <span className={assets?.ready ? 'done-mark' : 'muted'}>
                    {assets?.ready
                      ? '✓ all files'
                      : assets
                        ? `video ${percent(assets.video)} · takes ${percent(assets.recordings)}`
                        : 'loading…'}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="hint">Players without the whole video still see it, because it streams from the server.</p>
        </section>
      </aside>
    </div>
  )
}
