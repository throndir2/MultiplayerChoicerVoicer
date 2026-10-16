import { useEffect, useMemo, useState } from 'react'
import { ClientEvents, taskCounts, unfinishedPlayers } from '@mcv/shared'
import { ProgressBar, ScoreBadge, percent } from '../components/ui'
import { useMicrophone } from '../lib/microphone'
import { useRoom } from '../lib/room'
import { ProgressPanel } from './ProgressPanel'
import { Recorder } from './Recorder'

const GUIDE_KEY = 'mcv:guide-volume'
const AUTO_PLAY_KEY = 'mcv:auto-play-original'

function savedGuideVolume(): number {
  const saved = Number(window.localStorage.getItem(GUIDE_KEY) ?? '0.3')
  return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.3
}

function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function RecordingView() {
  const { room, me, roundManifest: manifest, command, notify } = useRoom()
  const mic = useMicrophone()
  const [guideVolume, setGuideVolume] = useState(savedGuideVolume)
  const [autoPlay, setAutoPlay] = useState(() => window.localStorage.getItem(AUTO_PLAY_KEY) !== '0')
  /** True after the player moved to another line. The first line does not play by itself. */
  const [navigated, setNavigated] = useState(false)
  const round = room.round
  const allowBack = room.settings.allowGoingBack
  const showScene = room.settings.showSceneWhileRecording

  const tasks = useMemo(() => {
    if (!round || !manifest || !me) return []
    return round.dubs.flatMap((dub) =>
      manifest.lines.filter((line) => dub.assignments[line.id] === me.id).map((line) => ({ dub, line })),
    )
  }, [round, manifest, me])

  const [index, setIndex] = useState(-1)
  useEffect(() => {
    if (index === -1 && tasks.length > 0) {
      const firstOpen = tasks.findIndex((task) => !task.dub.recordings[task.line.id])
      setIndex(firstOpen === -1 ? tasks.length - 1 : firstOpen)
    }
  }, [tasks, index])

  function goTo(taskIndex: number) {
    if (taskIndex === index) return
    setNavigated(true)
    setIndex(taskIndex)
  }

  const counts = taskCounts(room)
  const totals = [...counts.values()].reduce(
    (sum, entry) => ({ assigned: sum.assigned + entry.assigned, recorded: sum.recorded + entry.recorded }),
    { assigned: 0, recorded: 0 },
  )
  const mine = me ? counts.get(me.id) : undefined
  const myMissing = mine ? mine.assigned - mine.recorded : 0
  const finished = Boolean(me && round?.finished?.[me.id])
  const names = new Map(room.players.map((player) => [player.id, player.name]))
  const waiting = unfinishedPlayers(room)
  const waitingNames = waiting.map((id) => (id === me?.id ? 'you' : (names.get(id) ?? 'Player')))

  async function finishRecording() {
    if (myMissing > 0) {
      notify(`Record every line first (${myMissing} missing)`)
      return
    }
    if (!window.confirm('Are you done? You cannot change your lines after this.')) return
    try {
      await command(ClientEvents.roundFinish)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The request failed')
    }
  }

  if (!round || !manifest) {
    return (
      <div className="center-screen">
        <div className="spinner" />
        <p>Loading the pack…</p>
      </div>
    )
  }

  const current = tasks[index] ?? tasks[0]
  const videoNotice =
    room.pack && room.pack.id === round.packId && room.pack.videoStatus !== 'ready'
      ? room.pack.videoStatus === 'error'
        ? 'The video could not be converted. Playback is not possible.'
        : `The server is still converting the video (${percent(room.pack.videoProgress)}). This does not stop you from recording.`
      : null

  return (
    <div className="recording">
      <div className="recording__bar card">
        <div>
          <h2>Record your lines</h2>
          <p className="muted">
            {round.mode === 'versus'
              ? 'You dub the whole pack. Then everybody watches each dub and votes.'
              : round.mode === 'cast'
                ? 'You voice your characters. The dubs of all players play together at the end.'
                : 'Your lines are a random mix. The result plays at the end.'}
          </p>
          {videoNotice && <p className="hint">{videoNotice}</p>}
        </div>
        <div className="recording__totals">
          <ProgressBar
            value={totals.assigned ? totals.recorded / totals.assigned : 0}
            label={`Room: ${totals.recorded} of ${totals.assigned} lines`}
          />
          <p className="muted">
            {waiting.length === 0
              ? 'Everybody is done. The playback starts now.'
              : `Playback starts automatically when everybody is done. Waiting for ${nameList(waitingNames)}.`}
          </p>
        </div>
      </div>

      <div className="recording__grid">
        <aside className="card tasks">
          <h3>
            Your lines <span className="muted">({mine?.recorded ?? 0}/{mine?.assigned ?? 0})</span>
          </h3>
          {tasks.length === 0 ? (
            <div>
              <p className="muted">You do not have lines in this round. You can watch the progress of the others.</p>
              {round.mode === 'versus' && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() =>
                    void command(ClientEvents.roundJoin).catch((error: Error) => notify(error.message))
                  }
                >
                  Join in with my own dub
                </button>
              )}
            </div>
          ) : (
            <ol className="tasks__list">
              {tasks.map((task, taskIndex) => {
                const done = Boolean(task.dub.recordings[task.line.id])
                return (
                  <li key={`${task.dub.id}:${task.line.id}`}>
                    <button
                      type="button"
                      className={`tasks__item${taskIndex === index ? ' is-current' : ''}${done ? ' is-done' : ''}`}
                      onClick={() => goTo(taskIndex)}
                      disabled={finished || (!allowBack && taskIndex !== index)}
                    >
                      <span className="tasks__check">{done ? '✓' : taskIndex + 1}</span>
                      <span className="tasks__text">
                        <strong>{task.line.characters.join(' & ')}</strong>
                        <span>{task.line.text}</span>
                      </span>
                      <ScoreBadge score={task.dub.recordings[task.line.id]?.score} />
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
          {tasks.length > 0 && !finished && (
            <div className="tasks__finish">
              <button
                type="button"
                className="button button--primary"
                disabled={myMissing > 0}
                onClick={() => void finishRecording()}
              >
                ✓ I am done
              </button>
              <p className="hint">
                {myMissing > 0
                  ? `Record every line, then press “I am done”. ${myMissing} to go.`
                  : 'You recorded every line! Press “I am done” when you are happy with your takes.'}
              </p>
            </div>
          )}
          {finished && <p className="success-text">You are done! 🎉</p>}
        </aside>

        <div className="recording__main">
          {finished ? (
            <section className="card recording__done">
              <h3>✓ You are done</h3>
              <p className="muted">
                {waitingNames.length > 0
                  ? `Waiting for ${nameList(waitingNames)}. The playback starts automatically when everybody is done.`
                  : 'The playback starts now.'}
              </p>
            </section>
          ) : current ? (
            <Recorder
              key={`${current.dub.id}:${current.line.id}`}
              dub={current.dub}
              line={current.line}
              manifest={manifest}
              position={index + 1}
              total={tasks.length}
              mic={mic}
              guideVolume={guideVolume}
              showScene={showScene}
              requireTake={!allowBack}
              autoPlay={autoPlay && navigated}
              onPrev={allowBack && index > 0 ? () => goTo(index - 1) : null}
              onNext={index < tasks.length - 1 ? () => goTo(index + 1) : null}
              onFinish={index === tasks.length - 1 ? () => void finishRecording() : null}
              canFinish={myMissing === 0}
            />
          ) : null}
          {tasks.length > 0 && !finished && (
            <section className="card mic-settings">
              <h3>Microphone</h3>
              {mic.error && <p className="error-text">{mic.error}</p>}
              <label className="field">
                <span>Input</span>
                <select value={mic.deviceId} onChange={(event) => mic.setDeviceId(event.target.value)}>
                  <option value="">Default microphone</option>
                  {mic.devices
                    .filter((device) => device.deviceId && device.deviceId !== 'default')
                    .map((device, deviceIndex) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Microphone ${deviceIndex + 1}`}
                      </option>
                    ))}
                </select>
              </label>
              <label className="toggle">
                <input type="checkbox" checked={mic.clean} onChange={(event) => mic.setClean(event.target.checked)} />
                <span>Noise suppression and automatic volume</span>
              </label>
              <label className="field">
                <span>
                  Original voice while recording: {guideVolume > 0 ? `${Math.round(guideVolume * 100)} %` : 'off'}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={guideVolume}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    setGuideVolume(value)
                    window.localStorage.setItem(GUIDE_KEY, String(value))
                  }}
                />
              </label>
              <p className="hint">
                The original line plays at this volume while you record, so you can hear it and speak with it. Echo
                cancellation removes it from your take. Headphones still give the cleanest take.
              </p>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoPlay}
                  onChange={(event) => {
                    setAutoPlay(event.target.checked)
                    window.localStorage.setItem(AUTO_PLAY_KEY, event.target.checked ? '1' : '0')
                  }}
                />
                <span>Play the original line when I go to a line</span>
              </label>
            </section>
          )}
        </div>

        <aside className="recording__side">
          <ProgressPanel />
        </aside>
      </div>
    </div>
  )
}
