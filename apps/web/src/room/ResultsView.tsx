import { useState } from 'react'
import { ClientEvents, type DubView } from '@mcv/shared'
import { PlayerChip, ProgressBar, percent } from '../components/ui'
import { useRoom } from '../lib/room'
import { DubPlayer } from './DubPlayer'
import { dubTitle } from './PlaybackView'
import { WatchModal } from './VotingView'

function ExportButton({ dub }: { dub: DubView }) {
  const { command, notify, roundManifest } = useRoom()
  const state = dub.export
  if (state.status === 'ready' && state.url) {
    return (
      <a className="button button--small" href={state.url} download>
        ⬇ Download MP4
      </a>
    )
  }
  if (state.status === 'rendering') {
    return <ProgressBar small value={state.progress} label={`Making the video ${percent(state.progress)}`} />
  }
  return (
    <button
      type="button"
      className="button button--small"
      disabled={roundManifest?.videoStatus !== 'ready'}
      title={roundManifest?.videoStatus !== 'ready' ? 'The video is not converted yet' : undefined}
      onClick={() => void command(ClientEvents.dubExport, { dubId: dub.id }).catch((error: Error) => notify(error.message))}
    >
      {state.status === 'error' ? 'Try the export again' : '🎞 Export as video'}
    </button>
  )
}

export function ResultsView() {
  const { room, isHost, roundManifest, command, notify, me } = useRoom()
  const [watching, setWatching] = useState<DubView | null>(null)
  const round = room.round
  if (!round) return null
  const names = new Map(room.players.map((player) => [player.id, player.name]))

  function run(event: string, payload: unknown = {}) {
    void command(event, payload).catch((error: Error) => notify(error.message))
  }

  const tally = new Map<string, string[]>()
  for (const [voter, dubId] of Object.entries(room.votes)) {
    if (!dubId) continue
    tally.set(dubId, [...(tally.get(dubId) ?? []), voter])
  }
  const ranked = [...round.dubs].sort((a, b) => (tally.get(b.id)?.length ?? 0) - (tally.get(a.id)?.length ?? 0))
  const best = tally.get(ranked[0]?.id ?? '')?.length ?? 0
  const winners = best > 0 ? ranked.filter((dub) => (tally.get(dub.id)?.length ?? 0) === best) : []
  const single = round.dubs.length === 1 ? round.dubs[0] : null

  return (
    <div className="results">
      <section className="card">
        <div className="section-head">
          <h2>{single ? '🎬 Your dub is done!' : '🏆 Results'}</h2>
          {isHost && (
            <div className="button-row">
              <button type="button" className="button" onClick={() => run(ClientEvents.phaseSet, { phase: 'playback' })}>
                Watch together again
              </button>
              <button type="button" className="button button--primary" onClick={() => run(ClientEvents.roundStart)}>
                Play again with this pack
              </button>
              <button type="button" className="button button--ghost" onClick={() => run(ClientEvents.phaseSet, { phase: 'lobby' })}>
                Back to the lobby
              </button>
            </div>
          )}
        </div>
        {winners.length > 0 && (
          <p className="winner">
            {winners.length === 1 ? 'The winner is ' : 'A tie between '}
            <strong>{winners.map((dub) => dubTitle(dub, names)).join(' and ')}</strong> with {best}{' '}
            {best === 1 ? 'vote' : 'votes'}!
          </p>
        )}
        {single && roundManifest ? (
          <>
            <DubPlayer
              key={`${single.id}:${roundManifest.videoStatus}`}
              manifest={roundManifest}
              dub={single}
              fillMissing={room.settings.fillMissingWithOriginal}
              players={room.players}
            />
            <div className="button-row">
              <ExportButton dub={single} />
            </div>
          </>
        ) : (
          <ol className="ranking">
            {ranked.map((dub, index) => {
              const votes = tally.get(dub.id) ?? []
              return (
                <li key={dub.id} className={winners.includes(dub) ? 'is-winner' : ''}>
                  <span className="ranking__place">{index + 1}</span>
                  <div className="ranking__info">
                    <strong>{dubTitle(dub, names)}</strong>
                    <span className="muted">
                      {votes.length} {votes.length === 1 ? 'vote' : 'votes'}
                    </span>
                    <div className="ranking__voters">
                      {votes.map((voter) => {
                        const player = room.players.find((entry) => entry.id === voter)
                        return player ? <PlayerChip key={voter} name={player.name} color={player.color} small /> : null
                      })}
                    </div>
                  </div>
                  <div className="button-row">
                    <button type="button" className="button button--small" onClick={() => setWatching(dub)}>
                      ▶ Watch
                    </button>
                    <ExportButton dub={dub} />
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
      {me && (
        <label className="toggle card">
          <input
            type="checkbox"
            checked={me.spectator}
            onChange={(event) => run(ClientEvents.playerSpectate, { spectator: event.target.checked })}
          />
          <span>I only want to watch the next round (no recording)</span>
        </label>
      )}
      {!isHost && <p className="hint">The host can start a new round or go back to the lobby.</p>}
      {watching && <WatchModal dub={watching} onClose={() => setWatching(null)} />}
    </div>
  )
}
