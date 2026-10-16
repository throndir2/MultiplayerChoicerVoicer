import { useState } from 'react'
import {
  ClientEvents,
  formatBytes,
  formatSeconds,
  packVersionDate,
  type GameMode,
  type JobView,
  type RoomSettings,
} from '@mcv/shared'
import { Modal, PlayerChip, ProgressBar, formatWhen, percent, versionDates, versionLabel } from '../components/ui'
import { StorageButton } from '../components/StoragePanel'
import { assets } from '../lib/assets'
import { useAssetsVersion } from '../lib/preload'
import { useRoom } from '../lib/room'
import { roomInUse } from '../lib/storage'
import { Library } from './Library'
import { JobProgress, PackLists, STAGE_TEXT } from './PackLists'
import { PlayersPanel } from './PlayersPanel'
import { KeywordsCard, RandomPickNote, useRandomPack } from './RandomPack'

const MODES: { id: GameMode; icon: string; title: string; text: string }[] = [
  {
    id: 'versus',
    icon: '⚔️',
    title: 'Versus',
    text: 'Everybody dubs the whole pack. Then you watch every dub together and vote for the best one.',
  },
  {
    id: 'cast',
    icon: '🎭',
    title: 'Cast',
    text: 'Each player voices one or more characters. At the end you watch one shared dub.',
  },
  {
    id: 'chaos',
    icon: '🎲',
    title: 'Chaos',
    text: 'The lines are shuffled and shared at random between the players. Then you watch the result.',
  },
]

const STAGE_HINT = 'Check the pack now, for example its language. The host can cancel the download.'

/**
 * The pack that the server prepares: its name, its GameBanana page, pictures and text, and the host controls.
 * "Find another" gets a new random pack after a random pick. Otherwise it cancels and calls `onChoose`.
 */
export function JobStatus({ job, onChoose }: { job: JobView; onChoose?: (() => void) | undefined }) {
  const { room, isHost, command, notify } = useRoom()
  const random = useRandomPack()
  if (job.stage === 'ready') return null
  const failed = job.stage === 'error'
  const randomPick = room.randomPick && !room.randomPick.searching ? room.randomPick : null

  async function cancel(): Promise<boolean> {
    try {
      await command(ClientEvents.jobCancel)
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not cancel')
      return false
    }
  }

  function findAnother() {
    // The server stops the old download when the new pick replaces it.
    if (randomPick) void random.roll()
    else void cancel().then((ok) => ok && onChoose?.())
  }

  return (
    <div className={`job${failed ? ' job--error' : ''}`}>
      <div className="job__title">
        <strong>{job.label}</strong> — {STAGE_TEXT[job.stage]}
      </div>
      {failed ? (
        <p className="error-text">{job.message ?? 'The pack could not be prepared.'}</p>
      ) : (
        <JobProgress job={job} />
      )}
      {(job.pageUrl || job.images?.length || job.description) && (
        <div className="job__preview">
          {job.images && job.images.length > 0 && (
            <div className="job__images">
              {job.images.slice(0, 3).map((image) => (
                <a key={image} href={job.pageUrl ?? image} target="_blank" rel="noreferrer">
                  <img src={image} alt="" loading="lazy" />
                </a>
              ))}
            </div>
          )}
          {job.description && <p className="job__description">{job.description}</p>}
          {job.pageUrl && (
            <a href={job.pageUrl} target="_blank" rel="noreferrer">
              Open on GameBanana ↗
            </a>
          )}
        </div>
      )}
      {isHost ? (
        <div className="button-row job__actions">
          {(randomPick || onChoose) && (
            <button type="button" className="button button--small" disabled={random.searching} onClick={findAnother}>
              {randomPick ? '🎲 Another random pack' : '🔍 Find another pack'}
            </button>
          )}
          <button type="button" className="button button--small button--ghost" onClick={() => void cancel()}>
            {failed ? 'Dismiss' : '✕ Cancel'}
          </button>
        </div>
      ) : (
        !failed && <p className="hint">{STAGE_HINT}</p>
      )}
    </div>
  )
}

/** The server has more than one version of the current pack: an update with fixes, or an alternate. */
function PackVersions() {
  const { room, isHost, command, notify } = useRoom()
  const versions = room.packVersions
  const index = versions.findIndex((entry) => entry.id === room.pack?.id)
  const current = versions[index]
  if (!current) return null
  return (
    <div className="pack__versions">
      <p className="muted">
        📚 This server has {versions.length} versions of this pack (updates or alternates). This is{' '}
        {versionLabel(index, versions.length).toLowerCase()}: {versionDates(current)}.
      </p>
      {isHost && (
        <label className="field">
          <span>Version</span>
          <select
            value={current.id}
            onChange={(event) =>
              void command(ClientEvents.packSelect, { packId: event.target.value }).catch((error: Error) =>
                notify(error.message),
              )
            }
          >
            {versions.map((entry, position) => (
              <option key={entry.id} value={entry.id}>
                {versionLabel(position, versions.length)} · {formatWhen(packVersionDate(entry))} · {entry.lineCount} lines
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

function PackCard({ onChoose }: { onChoose: () => void }) {
  const { room, manifest, isHost, command, notify, me } = useRoom()
  const [preview, setPreview] = useState(false)
  useAssetsVersion()
  const pack = room.pack
  const job = room.job && room.job.stage !== 'ready' ? room.job : null

  const myAssets = me?.assets && pack && me.assets.packId === pack.id ? me.assets : null
  const downloaded = manifest
    ? [manifest.videoUrl, manifest.backingUrl, ...manifest.lines.flatMap((line) => [line.imageUrl, line.promptUrl])]
        .filter((url): url is string => Boolean(url))
        .reduce((sum, url) => sum + (assets.state(url).status === 'done' ? assets.state(url).total : assets.state(url).loaded), 0)
    : 0
  const totalBytes = manifest
    ? manifest.videoBytes +
      manifest.backingBytes +
      manifest.lines.reduce((sum, line) => sum + line.imageBytes + line.promptBytes, 0)
    : 0

  return (
    <section className="card pack-card">
      <div className="section-head">
        <h2>Pack</h2>
        {isHost ? (
          <button type="button" className="button button--primary" onClick={onChoose}>
            {pack ? 'Change pack' : 'Choose a pack'}
          </button>
        ) : null}
      </div>
      {job && <JobStatus job={job} onChoose={isHost ? onChoose : undefined} />}
      {/* While a job runs, "Another random pack" is in the job controls. */}
      <RandomPickNote withButton={!job} />
      {!pack && !job && (
        <p className="muted">
          {isHost
            ? 'Choose a pack from GameBanana, from the packs on this server, or upload your own. Or get a random pack from keywords below.'
            : 'The host has not chosen a pack yet.'}
        </p>
      )}
      {pack && (
        <div className="pack">
          {pack.iconUrl && <img className="pack__icon" src={pack.iconUrl} alt="" />}
          <div className="pack__info">
            <h3 className="pack__title">{pack.title}</h3>
            {pack.subtitle && <p className="pack__subtitle">{pack.subtitle}</p>}
            {pack.authors.length > 0 && <p className="muted">by {pack.authors.join(', ')}</p>}
            <p className="pack__stats">
              {pack.lineCount} lines · {pack.characterCount} characters · {formatSeconds(pack.duration)}
            </p>
            {pack.source.pageUrl && (
              <a href={pack.source.pageUrl} target="_blank" rel="noreferrer">
                Open on GameBanana ↗
              </a>
            )}
            {pack.source.kind === 'upload' && <p className="muted">Uploaded by {pack.source.uploader}</p>}
            {room.packVersions.length > 1 && <PackVersions />}
            <div className="pack__video">
              {pack.videoStatus === 'ready' && (
                <button type="button" className="button button--small" onClick={() => setPreview(true)}>
                  ▶ Watch the original clip
                </button>
              )}
              {(pack.videoStatus === 'pending' || pack.videoStatus === 'processing') && (
                <ProgressBar
                  small
                  value={pack.videoProgress}
                  label={`The server converts the video for browsers: ${percent(pack.videoProgress)}`}
                />
              )}
              {pack.videoStatus === 'error' && <p className="error-text">The video could not be converted.</p>}
            </div>
          </div>
        </div>
      )}
      {isHost && room.packChoices.length > 1 && (
        <label className="field">
          <span>This archive has {room.packChoices.length} packs</span>
          <select
            value={pack?.id ?? ''}
            onChange={(event) =>
              void command(ClientEvents.packSelect, { packId: event.target.value }).catch((error: Error) =>
                notify(error.message),
              )
            }
          >
            {room.packChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.title} ({choice.lineCount} lines)
              </option>
            ))}
          </select>
        </label>
      )}
      {manifest && (
        <div className="download-status">
          <ProgressBar
            small
            value={totalBytes ? downloaded / totalBytes : 0}
            label={
              myAssets?.ready
                ? `Everything is on this device (${formatBytes(totalBytes)})`
                : `Downloaded to this device: ${formatBytes(downloaded)} of ${formatBytes(totalBytes)}${manifest.videoUrl ? '' : ' (video comes later)'}`
            }
          />
          <StorageButton
            className="button button--tiny button--ghost"
            label="Manage downloaded files"
            inUse={roomInUse(room)}
          />
        </div>
      )}
      {manifest?.readme && (
        <details className="readme">
          <summary>Notes from the pack author</summary>
          <p>{manifest.readme}</p>
        </details>
      )}
      {preview && manifest?.videoUrl && (
        <Modal title={manifest.title} onClose={() => setPreview(false)} wide>
          <video
            className="preview-video"
            src={assets.objectUrl(manifest.videoUrl) ?? manifest.videoUrl}
            controls
            autoPlay
            playsInline
          />
        </Modal>
      )}
    </section>
  )
}

function CastEditor() {
  const { room, manifest, isHost, command, notify } = useRoom()
  if (!manifest) return null
  const players = room.players.filter((player) => !player.spectator)
  const byId = new Map(room.players.map((player) => [player.id, player]))
  return (
    <div className="cast">
      <div className="section-head">
        <h3>Who voices whom</h3>
        {isHost && (
          <button
            type="button"
            className="button button--small"
            onClick={() => void command(ClientEvents.castAuto).catch((error: Error) => notify(error.message))}
          >
            🎲 Auto-cast
          </button>
        )}
      </div>
      <table className="cast__table">
        <thead>
          <tr>
            <th>Character</th>
            <th>Lines</th>
            <th>Time</th>
            <th>Player</th>
          </tr>
        </thead>
        <tbody>
          {manifest.characters.map((character) => {
            const assigned = room.cast[character.name]
            const player = assigned ? byId.get(assigned) : undefined
            return (
              <tr key={character.name}>
                <td>{character.name}</td>
                <td>{character.lineCount}</td>
                <td>{Math.round(character.seconds)} s</td>
                <td>
                  {isHost ? (
                    <select
                      value={assigned ?? ''}
                      onChange={(event) =>
                        void command(ClientEvents.castAssign, {
                          character: character.name,
                          playerId: event.target.value || null,
                        }).catch((error: Error) => notify(error.message))
                      }
                    >
                      <option value="">Automatic</option>
                      {players.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                  ) : player ? (
                    <PlayerChip name={player.name} color={player.color} small />
                  ) : (
                    <span className="muted">Automatic</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="hint">Characters set to “Automatic” are shared out when the round starts, so that each player has about the same speaking time.</p>
    </div>
  )
}

export function Lobby() {
  const { room, isHost, command, notify, me } = useRoom()
  const [library, setLibrary] = useState(false)
  const [starting, setStarting] = useState(false)
  const pack = room.pack
  const jobBusy = (room.job && room.job.stage !== 'ready' && room.job.stage !== 'error') || room.randomPick?.searching
  const active = room.players.filter((player) => player.connected && !player.spectator)
  const host = room.players.find((player) => player.id === room.hostId)

  let blocker = ''
  if (!pack) blocker = 'Choose a pack first.'
  else if (active.length === 0) blocker = 'At least one player must take part.'

  async function start() {
    setStarting(true)
    try {
      await command(ClientEvents.roundStart)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not start')
    } finally {
      setStarting(false)
    }
  }

  function setMode(mode: GameMode) {
    if (!isHost) return
    void command(ClientEvents.settingsUpdate, { mode }).catch((error: Error) => notify(error.message))
  }

  function setSetting(patch: Partial<RoomSettings>) {
    void command(ClientEvents.settingsUpdate, patch).catch((error: Error) => notify(error.message))
  }

  return (
    <div className="lobby">
      <aside className="lobby__side">
        <PlayersPanel />
        {me && (
          <label className="toggle card">
            <input
              type="checkbox"
              checked={me.spectator}
              onChange={(event) =>
                void command(ClientEvents.playerSpectate, { spectator: event.target.checked }).catch((error: Error) =>
                  notify(error.message),
                )
              }
            />
            <span>I only want to watch (no recording)</span>
          </label>
        )}
      </aside>
      <div className="lobby__main">
        <PackCard onChoose={() => setLibrary(true)} />
        <PackLists />
        <KeywordsCard />
        <section className="card">
          <h2>Game mode</h2>
          <div className="modes">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={`mode${room.settings.mode === mode.id ? ' is-selected' : ''}`}
                onClick={() => setMode(mode.id)}
                disabled={!isHost && room.settings.mode !== mode.id}
                aria-pressed={room.settings.mode === mode.id}
              >
                <span className="mode__icon">{mode.icon}</span>
                <strong>{mode.title}</strong>
                <span>{mode.text}</span>
              </button>
            ))}
          </div>
          {room.settings.mode === 'cast' && <CastEditor />}
          <label className="toggle">
            <input
              type="checkbox"
              checked={room.settings.fillMissingWithOriginal}
              disabled={!isHost}
              onChange={(event) => setSetting({ fillMissingWithOriginal: event.target.checked })}
            />
            <span>If a line is not recorded, play the original line</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={room.settings.showSceneWhileRecording}
              disabled={!isHost}
              onChange={(event) => setSetting({ showSceneWhileRecording: event.target.checked })}
            />
            <span>Show the scene (pictures and video) while recording. Off keeps it a surprise until you watch.</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={room.settings.allowGoingBack}
              disabled={!isHost}
              onChange={(event) => setSetting({ allowGoingBack: event.target.checked })}
            />
            <span>Players can go back to earlier lines and record them again</span>
          </label>
        </section>
        <section className="card start">
          {isHost ? (
            <>
              <button
                type="button"
                className="button button--primary button--big"
                disabled={Boolean(blocker) || starting || Boolean(jobBusy)}
                onClick={() => void start()}
              >
                {starting ? 'Starting…' : '🎬 Start recording'}
              </button>
              <p className="muted">
                {blocker ||
                  (jobBusy
                    ? 'Wait until the new pack is ready.'
                    : `${active.length} ${active.length === 1 ? 'player takes' : 'players take'} part. The video can finish converting while you record.`)}
              </p>
            </>
          ) : (
            <p className="muted">Waiting for {host?.name ?? 'the host'} to start the round…</p>
          )}
        </section>
      </div>
      {library && <Library onClose={() => setLibrary(false)} />}
    </div>
  )
}
