import { useEffect, useMemo, useState } from 'react'
import { ClientEvents, taskCounts } from '@mcv/shared'
import { ProgressBar, percent } from '../components/ui'
import { useMicrophone } from '../lib/microphone'
import { useRoom } from '../lib/room'
import { ProgressPanel } from './ProgressPanel'
import { Recorder } from './Recorder'

const GUIDE_KEY = 'mcv:guide-volume'

function savedGuideVolume(): number {
  const saved = Number(window.localStorage.getItem(GUIDE_KEY) ?? '0.3')
  return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.3
}

export function RecordingView() {
  const { room, me, isHost, roundManifest: manifest, command, notify } = useRoom()
  const mic = useMicrophone()
  const [guideVolume, setGuideVolume] = useState(savedGuideVolume)
  const round = room.round

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
      setIndex(firstOpen === -1 ? 0 : firstOpen)
    }
  }, [tasks, index])

  const counts = taskCounts(room)
  const totals = [...counts.values()].reduce(
    (sum, entry) => ({ assigned: sum.assigned + entry.assigned, recorded: sum.recorded + entry.recorded }),
    { assigned: 0, recorded: 0 },
  )
  const mine = me ? counts.get(me.id) : undefined
  const missing = totals.assigned - totals.recorded

  async function toPlayback() {
    if (missing > 0 && !window.confirm(`${missing} lines are not recorded yet. Go to playback anyway?`)) return
    try {
      await command(ClientEvents.phaseSet, { phase: 'playback' })
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
          {isHost && (
            <button type="button" className="button button--primary" onClick={() => void toPlayback()}>
              {missing > 0 ? 'Go to playback' : '🎬 Everybody is done: watch!'}
            </button>
          )}
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
                      onClick={() => setIndex(taskIndex)}
                    >
                      <span className="tasks__check">{done ? '✓' : taskIndex + 1}</span>
                      <span className="tasks__text">
                        <strong>{task.line.characters.join(' & ')}</strong>
                        <span>{task.line.text}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
          {mine && mine.assigned > 0 && mine.recorded >= mine.assigned && (
            <p className="success-text">You recorded every line! 🎉 You can still record any line again.</p>
          )}
        </aside>

        <div className="recording__main">
          {current ? (
            <Recorder
              key={`${current.dub.id}:${current.line.id}`}
              dub={current.dub}
              line={current.line}
              manifest={manifest}
              position={index + 1}
              total={tasks.length}
              mic={mic}
              guideVolume={guideVolume}
              onPrev={index > 0 ? () => setIndex(index - 1) : null}
              onNext={index < tasks.length - 1 ? () => setIndex(index + 1) : null}
            />
          ) : null}
          {tasks.length > 0 && (
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
                The original line plays at this volume while you record, so you can hear it and speak with it. Use
                headphones, or the microphone also records the original line.
              </p>
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
