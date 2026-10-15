import { useState } from 'react'
import { ClientEvents, type PlayerView } from '@mcv/shared'
import { percent, ProgressBar } from '../components/ui'
import { useRoom } from '../lib/room'

function assetsLine(player: PlayerView, packId: string | null): string | null {
  const assets = player.assets
  if (!assets || !packId || assets.packId !== packId) return null
  if (assets.ready) return 'All files downloaded'
  return `Lines ${percent(assets.lines)} · video ${percent(assets.video)}`
}

export function PlayersPanel({ showInvite = true }: { showInvite?: boolean }) {
  const { room, session, isHost, command, notify } = useRoom()
  const [copied, setCopied] = useState<'link' | 'code' | null>(null)
  const link = `${window.location.origin}/join/${room.code}`
  const packId = room.round?.packId ?? room.pack?.id ?? null

  async function copy(text: string, what: 'link' | 'code') {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      window.prompt('Copy this:', text)
    }
  }

  async function run(event: string, payload: unknown) {
    try {
      await command(event, payload)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The request failed')
    }
  }

  return (
    <section className="card players">
      {showInvite && (
        <div className="invite">
          <h3>Invite friends</h3>
          <button type="button" className="invite__code" onClick={() => void copy(room.code, 'code')} title="Copy the code">
            {room.code}
          </button>
          <div className="invite__link">
            <input readOnly value={link} onFocus={(event) => event.currentTarget.select()} aria-label="Invite link" />
            <button type="button" className="button button--small" onClick={() => void copy(link, 'link')}>
              {copied === 'link' ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          {copied === 'code' && <p className="hint">Code copied.</p>}
        </div>
      )}
      <h3>
        Players <span className="muted">({room.players.length})</span>
      </h3>
      <ul className="players__list">
        {room.players.map((player) => {
          const isMe = player.id === session.playerId
          const status = assetsLine(player, packId)
          return (
            <li key={player.id} className={`players__item${player.connected ? '' : ' is-away'}`}>
              <span className="players__dot" style={{ background: player.color }} />
              <div className="players__info">
                <div className="players__name">
                  {player.name}
                  {isMe && <span className="muted"> (you)</span>}
                  {player.id === room.hostId && (
                    <span className="badge" title="Host">
                      👑 host
                    </span>
                  )}
                  {player.spectator && <span className="badge badge--dim">watching</span>}
                  {!player.connected && <span className="badge badge--dim">away</span>}
                </div>
                {status && player.assets && (
                  <ProgressBar
                    small
                    value={(player.assets.lines + player.assets.video + player.assets.backing) / 3}
                    label={status}
                    color={player.color}
                  />
                )}
              </div>
              {isHost && !isMe && (
                <div className="players__actions">
                  <button
                    type="button"
                    className="button button--tiny"
                    onClick={() => void run(ClientEvents.hostTransfer, { playerId: player.id })}
                  >
                    Make host
                  </button>
                  <button
                    type="button"
                    className="button button--tiny button--danger"
                    onClick={() => {
                      if (window.confirm(`Remove ${player.name} from the room?`)) {
                        void run(ClientEvents.playerKick, { playerId: player.id })
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
