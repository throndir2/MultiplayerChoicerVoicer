import { useState } from 'react'
import { ClientEvents, type DubView } from '@mcv/shared'
import { Modal, PlayerChip } from '../components/ui'
import { useRoom } from '../lib/room'
import { DubDownloads } from './DubDownloads'
import { DubPlayer } from './DubPlayer'
import { dubTitle } from './PlaybackView'

export function WatchModal({ dub, onClose }: { dub: DubView; onClose: () => void }) {
  const { room, roundManifest } = useRoom()
  const names = new Map(room.players.map((player) => [player.id, player.name]))
  if (!roundManifest) return null
  // The room state changes while the modal is open (for example the export progress), so show the newest dub.
  const current = room.round?.dubs.find((entry) => entry.id === dub.id) ?? dub
  return (
    <Modal title={dubTitle(dub, names)} onClose={onClose} wide>
      <DubPlayer
        manifest={roundManifest}
        dub={dub}
        fillMissing={room.settings.fillMissingWithOriginal}
        players={room.players}
        autoPlay
      />
      <div className="button-row">
        <DubDownloads dub={current} title={dubTitle(current, names)} />
      </div>
    </Modal>
  )
}

export function VotingView() {
  const { room, me, isHost, command, notify } = useRoom()
  const [watching, setWatching] = useState<DubView | null>(null)
  const round = room.round
  if (!round) return null
  const names = new Map(room.players.map((player) => [player.id, player.name]))
  const myVote = me ? room.votes[me.id] : undefined
  const voters = room.players.filter((player) => player.connected)

  function vote(dubId: string) {
    void command(ClientEvents.voteCast, { dubId }).catch((error: Error) => notify(error.message))
  }

  return (
    <div className="voting">
      <section className="card">
        <div className="section-head">
          <h2>🗳 Vote for your favourite dub</h2>
          {isHost && (
            <button
              type="button"
              className="button button--primary"
              onClick={() =>
                void command(ClientEvents.phaseSet, { phase: 'results' }).catch((error: Error) => notify(error.message))
              }
            >
              Show the results
            </button>
          )}
        </div>
        <p className="muted">You cannot vote for your own dub. The results show when everybody has voted.</p>
        <div className="vote-grid">
          {round.dubs.map((dub) => {
            const own = dub.ownerId === me?.id
            const owner = room.players.find((player) => player.id === dub.ownerId)
            return (
              <div key={dub.id} className={`vote-card${myVote === dub.id ? ' is-selected' : ''}`}>
                <div className="vote-card__name" style={{ borderColor: owner?.color }}>
                  {dubTitle(dub, names)}
                </div>
                <div className="muted">
                  {Object.keys(dub.recordings).length} of {Object.keys(dub.assignments).length} lines recorded
                </div>
                <div className="button-row">
                  <button type="button" className="button button--small" onClick={() => setWatching(dub)}>
                    ▶ Watch again
                  </button>
                  <button
                    type="button"
                    className="button button--small button--primary"
                    disabled={own}
                    onClick={() => vote(dub.id)}
                  >
                    {own ? 'Your dub' : myVote === dub.id ? '✓ Your vote' : 'Vote'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
      <section className="card">
        <h3>Votes</h3>
        <ul className="ready-list">
          {voters.map((player) => (
            <li key={player.id}>
              <PlayerChip name={player.name} color={player.color} small />
              <span className={room.votes[player.id] !== undefined ? 'done-mark' : 'muted'}>
                {room.votes[player.id] !== undefined ? '✓ voted' : 'thinking…'}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {watching && <WatchModal dub={watching} onClose={() => setWatching(null)} />}
    </div>
  )
}
