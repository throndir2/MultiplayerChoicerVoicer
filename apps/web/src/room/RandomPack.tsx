import { useState, type FormEvent } from 'react'
import { ClientEvents, MAX_KEYWORDS, type JobView } from '@mcv/shared'
import { api } from '../lib/api'
import { useRoom } from '../lib/room'
import { JobStatus } from './Lobby'

/** Asks the server for a random GameBanana pack that matches one of the room keywords. Host only. */
export function useRandomPack() {
  const { room, session, notify } = useRoom()
  const [busy, setBusy] = useState(false)
  async function roll() {
    setBusy(true)
    try {
      await api<{ job: JobView | null }>(`/api/rooms/${room.code}/source`, {
        body: { kind: 'random' },
        token: session.token,
      })
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The request failed')
    } finally {
      setBusy(false)
    }
  }
  return { roll, searching: busy || Boolean(room.randomPick?.searching) }
}

/** Tells the room where the current pack came from, with a re-roll button for the host. */
export function RandomPickNote({ withButton }: { withButton?: boolean }) {
  const { room, isHost } = useRoom()
  const { roll, searching } = useRandomPack()
  const pick = room.randomPick
  if (!pick) return null
  return (
    <div className="random-pick">
      <span>
        {pick.searching ? (
          '🎲 The server looks for a random pack…'
        ) : (
          <>
            🎲 Random pick
            {pick.keyword ? (
              <>
                {' '}
                for <strong>“{pick.keyword}”</strong>
              </>
            ) : (
              ' from all packs'
            )}{' '}
            <span className="muted">
              ({pick.matches} {pick.matches === 1 ? 'pack matches' : 'packs match'})
            </span>
          </>
        )}
      </span>
      {withButton && isHost && !pick.searching && (
        <button type="button" className="button button--small" disabled={searching} onClick={() => void roll()}>
          🎲 Another random pack
        </button>
      )}
    </div>
  )
}

/** The shared keyword list. Every player can add and remove keywords. The host picks a random pack. */
export function KeywordsCard({ showPack }: { showPack?: boolean }) {
  const { room, isHost, command, notify } = useRoom()
  const { roll, searching } = useRandomPack()
  const [text, setText] = useState('')
  const players = new Map(room.players.map((player) => [player.id, player]))
  const host = players.get(room.hostId)
  const full = room.keywords.length >= MAX_KEYWORDS
  const job = room.job && room.job.stage !== 'ready' ? room.job : null
  const nextPack = showPack && room.pack && room.pack.id !== room.round?.packId ? room.pack : null

  function add(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) return
    void command(ClientEvents.keywordAdd, { text })
      .then(() => setText(''))
      .catch((error: Error) => notify(error.message))
  }

  function remove(keyword: string) {
    void command(ClientEvents.keywordRemove, { keyword }).catch((error: Error) => notify(error.message))
  }

  return (
    <section className="card keywords">
      <div className="section-head">
        <h2>🎲 Random pack</h2>
        {isHost && (
          <button type="button" className="button button--primary" disabled={searching} onClick={() => void roll()}>
            {searching ? 'Looking for a pack…' : room.randomPick ? '🎲 Another random pack' : '🎲 Random pack'}
          </button>
        )}
      </div>
      <p className="muted">
        Add keywords, for example a show, a game or a character. {isHost ? 'You' : (host?.name ?? 'The host')} can then
        get a random GameBanana pack that matches one of the keywords. Without keywords, the pack comes from all packs.
      </p>
      {room.keywords.length > 0 && (
        <ul className="keywords__list">
          {room.keywords.map((keyword) => {
            const player = players.get(keyword.playerId)
            return (
              <li
                key={keyword.text}
                className="keyword"
                style={player ? { borderColor: player.color } : undefined}
                title={player ? `Added by ${player.name}` : undefined}
              >
                {keyword.text}
                <button
                  type="button"
                  className="keyword__remove"
                  aria-label={`Remove ${keyword.text}`}
                  onClick={() => remove(keyword.text)}
                >
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <form className="keywords__form" onSubmit={add}>
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={full ? 'The list is full' : 'Shrek, SpongeBob, Hazbin…'}
          maxLength={400}
          disabled={full}
          aria-label="Keywords"
        />
        <button type="submit" className="button" disabled={full || !text.trim()}>
          Add
        </button>
      </form>
      <p className="hint">
        Separate keywords with commas. Each keyword has the same chance. The pick skips rated packs, packs that this room
        already played, and files above the download limit.
      </p>
      {showPack && (
        <>
          {job && <JobStatus job={job} />}
          <RandomPickNote />
          {nextPack && (
            <p>
              Next pack: <strong>{nextPack.title}</strong>{' '}
              <span className="muted">
                ({nextPack.lineCount} lines · {nextPack.characterCount} characters)
              </span>
            </p>
          )}
        </>
      )}
    </section>
  )
}
