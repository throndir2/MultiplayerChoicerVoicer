import { useEffect, useState, type FormEvent } from 'react'
import { useLocation } from 'wouter'
import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH, type RoomInfoResponse, type SessionResponse } from '@mcv/shared'
import { PackCreatorLink } from '../components/ui'
import { api, loadName, loadSession, saveName, saveSession } from '../lib/api'

const PHASE_TEXT: Record<string, string> = {
  lobby: 'in the lobby',
  recording: 'recording',
  playback: 'watching',
  voting: 'voting',
  results: 'looking at the results',
}

export function HomeScreen({ joinCode }: { joinCode?: string }) {
  const [, navigate] = useLocation()
  const [name, setName] = useState(loadName())
  const [code, setCode] = useState((joinCode ?? '').toUpperCase())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState<RoomInfoResponse | null>(null)

  useEffect(() => {
    if (!joinCode) return
    const upper = joinCode.toUpperCase()
    if (loadSession(upper)) {
      navigate(`/room/${upper}`, { replace: true })
      return
    }
    api<RoomInfoResponse>(`/api/rooms/${encodeURIComponent(upper)}`)
      .then(setInfo)
      .catch(() => setError('This room does not exist or has expired.'))
  }, [joinCode, navigate])

  async function enter(path: string) {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Type your name first.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const session = await api<SessionResponse>(path, { body: { name: trimmed } })
      saveName(trimmed)
      saveSession(session)
      navigate(`/room/${session.code}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong')
      setBusy(false)
    }
  }

  function onCreate(event: FormEvent) {
    event.preventDefault()
    void enter('/api/rooms')
  }

  function onJoin(event: FormEvent) {
    event.preventDefault()
    const cleaned = code.trim().toUpperCase()
    if (cleaned.length !== ROOM_CODE_LENGTH) {
      setError(`The room code has ${ROOM_CODE_LENGTH} characters.`)
      return
    }
    void enter(`/api/rooms/${encodeURIComponent(cleaned)}/players`)
  }

  return (
    <div className="home">
      <header className="home__hero">
        <div className="logo" aria-hidden="true">
          🎙️
        </div>
        <h1>Choicer Voicer Party</h1>
        <p>
          Dub Choicer Voicer packs together with your friends, right in the browser. Pick a pack from GameBanana or
          upload your own, record your lines, and watch the result together.
        </p>
      </header>

      <label className="field home__name">
        <span>Your name</span>
        <input
          value={name}
          maxLength={MAX_NAME_LENGTH}
          onChange={(event) => setName(event.target.value)}
          placeholder="For example: Ayaka"
          autoFocus
        />
      </label>

      {error && <p className="error-text">{error}</p>}

      <div className={`home__cards${joinCode ? ' home__cards--single' : ''}`}>
        {!joinCode && (
          <form className="card home__card" onSubmit={onCreate}>
            <h2>Create a room</h2>
            <p>You become the host. You choose the pack and the game mode, then you send the link to your friends.</p>
            <button className="button button--primary" disabled={busy}>
              Create room
            </button>
          </form>
        )}
        <form className="card home__card" onSubmit={onJoin}>
          <h2>{joinCode ? 'Join the room' : 'Join a room'}</h2>
          {info ? (
            <p>
              {info.hostName ? `${info.hostName}'s room` : 'A room'} with {info.playerCount}{' '}
              {info.playerCount === 1 ? 'player' : 'players'}, now {PHASE_TEXT[info.phase] ?? info.phase}
              {info.packTitle ? `. Pack: ${info.packTitle}` : ''}.
            </p>
          ) : (
            <p>Type the code from your friend, or open their invite link.</p>
          )}
          <label className="field">
            <span>Room code</span>
            <input
              className="code-input"
              value={code}
              maxLength={ROOM_CODE_LENGTH}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABCDE"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <button className="button button--primary" disabled={busy}>
            Join
          </button>
        </form>
      </div>

      {!joinCode && (
        <div className="home__creator">
          <PackCreatorLink />
          <p>Turn any video or YouTube link into a dub pack with the free Windows app.</p>
        </div>
      )}

      <footer className="home__footer">
        <p>
          Packs come from the <a href="https://gamebanana.com/games/20674">The Choicer Voicer</a> community on
          GameBanana. This is an unofficial fan project. You need a microphone and a browser such as Chrome, Edge,
          Firefox or Safari.
        </p>
      </footer>
    </div>
  )
}
