import { useEffect, useState } from 'react'
import { ClientEvents, type DubExportFormat, type DubExportView, type DubView } from '@mcv/shared'
import { ProgressBar, percent } from '../components/ui'
import { useRoom } from '../lib/room'

function safeFileName(text: string): string {
  return (
    text
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'dub'
  )
}

function saveFile(url: string, name: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
}

const LABELS: Record<DubExportFormat, { idle: string; making: string; retry: string; title: string }> = {
  video: {
    idle: '⬇ Download video (MP4)',
    making: 'Making the video',
    retry: 'Try the video again',
    title: 'The video with all the takes, the music and the subtitles',
  },
  game: {
    idle: '⬇ Download takes for Choicer Voicer (ZIP)',
    making: 'Making the ZIP',
    retry: 'Try the ZIP again',
    title:
      'The takes as WAV files in the recording format of the Choicer Voicer game (recordings\\dub_recordings). The README in the ZIP tells you where to put them.',
  },
}

function DownloadButton({
  dub,
  format,
  state,
  fileName,
  disabledReason,
}: {
  dub: DubView
  format: DubExportFormat
  state: DubExportView
  fileName: string
  disabledReason: string | null
}) {
  const { command, notify } = useRoom()
  // The player asked for the file: download it as soon as the server has made it.
  const [wanted, setWanted] = useState(false)
  const labels = LABELS[format]

  useEffect(() => {
    if (!wanted) return
    if (state.status === 'ready' && state.url) {
      saveFile(state.url, fileName)
      setWanted(false)
    } else if (state.status === 'error') {
      setWanted(false)
    }
  }, [wanted, state.status, state.url, fileName])

  if (state.status === 'ready' && state.url) {
    return (
      <a className="button button--small" href={state.url} download={fileName} title={labels.title}>
        {labels.idle}
      </a>
    )
  }
  if (state.status === 'rendering') {
    return <ProgressBar small value={state.progress} label={`${labels.making} ${percent(state.progress)}`} />
  }
  return (
    <button
      type="button"
      className="button button--small"
      disabled={Boolean(disabledReason)}
      title={disabledReason ?? labels.title}
      onClick={() => {
        setWanted(true)
        void command(ClientEvents.dubExport, {
          dubId: dub.id,
          format,
          timezoneOffset: new Date().getTimezoneOffset(),
        }).catch((error: Error) => {
          setWanted(false)
          notify(error.message)
        })
      }}
    >
      {state.status === 'error' ? labels.retry : labels.idle}
    </button>
  )
}

/** The downloads of a dub: the video, and the takes in the recording format of the Choicer Voicer game. */
export function DubDownloads({ dub, title }: { dub: DubView; title: string }) {
  const { room, roundManifest } = useRoom()
  if (!roundManifest) return null
  const name = safeFileName(`${roundManifest.title} - ${title}`)
  const hasTakes = Object.keys(dub.recordings).length > 0 || room.settings.fillMissingWithOriginal
  const gameReason = roundManifest.lines.some((line) => !line.file)
    ? 'This pack was prepared before the server kept the file names of the lines'
    : hasTakes
      ? null
      : 'This dub has no takes'
  return (
    <>
      <DownloadButton
        dub={dub}
        format="video"
        state={dub.export}
        fileName={`${name}.mp4`}
        disabledReason={roundManifest.videoStatus !== 'ready' ? 'The video is not converted yet' : null}
      />
      <DownloadButton
        dub={dub}
        format="game"
        state={dub.gameExport ?? { status: 'idle', progress: 0 }}
        fileName={`${name} (Choicer Voicer takes).zip`}
        disabledReason={gameReason}
      />
    </>
  )
}
