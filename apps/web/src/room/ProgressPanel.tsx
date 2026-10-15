import { taskCounts } from '@mcv/shared'
import { PlayerChip, ProgressBar, percent } from '../components/ui'
import { useRoom } from '../lib/room'

/** Shows how far every player is: a bar, the current line and scene, and a recording mark. */
export function ProgressPanel() {
  const { room, roundManifest } = useRoom()
  const counts = taskCounts(room)
  const lineById = new Map(roundManifest?.lines.map((line) => [line.id, line]) ?? [])
  const participants = room.players.filter((player) => (counts.get(player.id)?.assigned ?? 0) > 0)

  return (
    <section className="card progress-panel">
      <h3>Everybody's progress</h3>
      <ul>
        {participants.map((player) => {
          const count = counts.get(player.id) ?? { assigned: 0, recorded: 0 }
          const done = count.recorded >= count.assigned
          const progress = player.progress
          const line = progress?.lineId ? lineById.get(progress.lineId) : undefined
          const myLines =
            room.round?.dubs
              .filter((dub) => !progress?.dubId || dub.id === progress.dubId)
              .flatMap((dub) =>
                (roundManifest?.lines ?? []).filter((entry) => dub.assignments[entry.id] === player.id),
              ) ?? []
          const position = line ? myLines.findIndex((entry) => entry.id === line.id) + 1 : 0
          return (
            <li key={player.id} className={`progress-panel__item${player.connected ? '' : ' is-away'}`}>
              <div className="progress-panel__top">
                <PlayerChip name={player.name} color={player.color} small />
                {progress?.recording ? (
                  <span className="rec-dot">● recording</span>
                ) : done ? (
                  <span className="done-mark">✓ finished</span>
                ) : !player.connected ? (
                  <span className="muted">away</span>
                ) : null}
              </div>
              <ProgressBar
                value={count.assigned ? count.recorded / count.assigned : 0}
                color={player.color}
                label={`${count.recorded} of ${count.assigned} lines · ${percent(count.assigned ? count.recorded / count.assigned : 0)}`}
              />
              {line && !done && (
                <div className="progress-panel__scene">
                  {line.imageUrl && <img src={line.imageUrl} alt="" loading="lazy" />}
                  <span>
                    Line {position || '?'} of {myLines.length}: <em>{line.text}</em>
                  </span>
                </div>
              )}
              {player.assets && player.assets.packId === room.round?.packId && !player.assets.ready && (
                <span className="muted progress-panel__files">
                  Downloads: lines {percent(player.assets.lines)} · video {percent(player.assets.video)} · takes{' '}
                  {percent(player.assets.recordings)}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
