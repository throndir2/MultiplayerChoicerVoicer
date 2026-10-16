import { useState, type ReactNode } from 'react'
import { ClientEvents, formatBytes, type JobView, type PackPick, type QueueEntryView } from '@mcv/shared'
import { PlayerChip, ProgressBar, percent } from '../components/ui'
import { packDownload, useAssetsVersion } from '../lib/preload'
import { useManifest, useRoom } from '../lib/room'
import { Library, type LibraryTarget } from './Library'

export const STAGE_TEXT: Record<JobView['stage'], string> = {
  queued: 'Waiting for the server',
  resolving: 'Starting',
  downloading: 'The server downloads the pack',
  extracting: 'The server unpacks the pack',
  processing: 'The server prepares the lines',
  ready: 'Ready',
  error: 'Failed',
}

export function JobProgress({ job, small }: { job: JobView; small?: boolean }) {
  return (
    <ProgressBar
      small={Boolean(small)}
      value={job.progress}
      indeterminate={job.stage === 'extracting' || job.stage === 'queued' || job.stage === 'resolving'}
      label={
        small
          ? `${STAGE_TEXT[job.stage]}${job.stage === 'downloading' || job.stage === 'processing' ? ` ${percent(job.progress)}` : ''}`
          : job.stage === 'downloading' || job.stage === 'processing'
            ? percent(job.progress)
            : ''
      }
    />
  )
}

function DeviceProgress({ packId, version }: { packId: string; version: string }) {
  const manifest = useManifest(packId, version)
  useAssetsVersion()
  if (!manifest) return null
  const { loaded, total } = packDownload(manifest)
  return (
    <ProgressBar
      small
      value={total ? loaded / total : 0}
      label={`On this device: ${formatBytes(loaded)} of ${formatBytes(total)}${manifest.videoUrl ? '' : ' (video comes later)'}`}
    />
  )
}

function PickRow({ pick, verb, children, status }: { pick: PackPick; verb: string; children?: ReactNode; status?: ReactNode }) {
  const { room } = useRoom()
  const player = room.players.find((entry) => entry.id === pick.by)
  return (
    <li className="pick">
      {pick.imageUrl ? (
        <img className="pick__thumb" src={pick.imageUrl} alt="" loading="lazy" />
      ) : (
        <span className="pick__thumb pick__thumb--blank">🎬</span>
      )}
      <div className="pick__info">
        <strong>{pick.title}</strong>
        <span className="muted pick__meta">
          {verb} {player ? <PlayerChip name={player.name} color={player.color} small /> : 'a player who left'}
          {pick.pageUrl && (
            <a href={pick.pageUrl} target="_blank" rel="noreferrer">
              Open on GameBanana ↗
            </a>
          )}
        </span>
        {status}
      </div>
      {children && <div className="pick__actions">{children}</div>}
    </li>
  )
}

function QueueStatus({ entry }: { entry: QueueEntryView }) {
  if (entry.error) return <p className="error-text">{entry.error}</p>
  if (entry.pack) return <DeviceProgress packId={entry.pack.id} version={entry.pack.videoStatus} />
  if (entry.job) return <JobProgress job={entry.job} small />
  return <p className="hint">The server looks up the pack…</p>
}

/** The queue of the host and the suggestions of the players. */
export function PackLists() {
  const { room, isHost, me, command, notify } = useRoom()
  const [library, setLibrary] = useState<LibraryTarget | null>(null)
  const canUse = room.phase === 'lobby' || room.phase === 'results'

  function run(event: string, id: string) {
    void command(event, { id }).catch((error: Error) => notify(error.message))
  }

  return (
    <section className="card pack-lists">
      <div className="section-head">
        <h2>Next packs</h2>
        <div className="button-row">
          <button type="button" className="button button--small" onClick={() => setLibrary('suggest')}>
            💡 Suggest a pack
          </button>
          {isHost && (
            <button type="button" className="button button--small" onClick={() => setLibrary('queue')}>
              ➕ Add to the queue
            </button>
          )}
        </div>
      </div>

      <h3>Queue</h3>
      {room.queue.length === 0 ? (
        <p className="muted">
          {isHost
            ? 'Queue packs, so that the server and the browsers download them while you play.'
            : 'The host has not queued a pack.'}
        </p>
      ) : (
        <ol className="pick-list">
          {room.queue.map((entry) => (
            <PickRow key={entry.id} pick={entry} verb="Added by" status={<QueueStatus entry={entry} />}>
              {isHost && (
                <>
                  <button
                    type="button"
                    className="button button--small button--primary"
                    disabled={!canUse}
                    onClick={() => run(ClientEvents.queueUse, entry.id)}
                  >
                    ▶ Use now
                  </button>
                  <button type="button" className="button button--small button--ghost" onClick={() => run(ClientEvents.queueRemove, entry.id)}>
                    ✕ Remove
                  </button>
                </>
              )}
            </PickRow>
          ))}
        </ol>
      )}

      <h3>Suggestions</h3>
      {room.suggestions.length === 0 ? (
        <p className="muted">Anybody can suggest a pack. The host chooses what to play.</p>
      ) : (
        <ul className="pick-list">
          {room.suggestions.map((entry) => (
            <PickRow key={entry.id} pick={entry} verb="Suggested by">
              {isHost && (
                <>
                  <button
                    type="button"
                    className="button button--small button--primary"
                    disabled={!canUse}
                    onClick={() => run(ClientEvents.suggestionUse, entry.id)}
                  >
                    ▶ Use now
                  </button>
                  <button type="button" className="button button--small" onClick={() => run(ClientEvents.suggestionQueue, entry.id)}>
                    ➕ Queue
                  </button>
                </>
              )}
              {(isHost || entry.by === me?.id) && (
                <button type="button" className="button button--small button--ghost" onClick={() => run(ClientEvents.suggestionRemove, entry.id)}>
                  ✕ Remove
                </button>
              )}
            </PickRow>
          ))}
        </ul>
      )}
      {library && <Library target={library} onClose={() => setLibrary(null)} />}
    </section>
  )
}
