import { useEffect, type ReactNode } from 'react'
import { scoreLabel, type PackSummary } from '@mcv/shared'

export function ProgressBar({
  value,
  label,
  color,
  small,
  indeterminate,
}: {
  value: number
  label?: string
  color?: string
  small?: boolean
  indeterminate?: boolean
}) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div className={`progress${small ? ' progress--small' : ''}${indeterminate ? ' progress--busy' : ''}`}>
      <div className="progress__track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress__fill" style={{ width: `${indeterminate ? 100 : percent}%`, background: color }} />
      </div>
      {label !== undefined && <span className="progress__label">{label}</span>}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <div className={`modal__panel${wide ? ' modal__panel--wide' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  )
}

export function PlayerChip({ name, color, small }: { name: string; color: string; small?: boolean }) {
  return (
    <span className={`chip${small ? ' chip--small' : ''}`} style={{ borderColor: color }}>
      <span className="chip__dot" style={{ background: color }} />
      {name}
    </span>
  )
}

export const PACK_CREATOR_URL = 'https://github.com/throndir2/ChoicerVoicerPackCreator'

export function PackCreatorLink({ className = 'button' }: { className?: string }) {
  return (
    <a className={className} href={PACK_CREATOR_URL} target="_blank" rel="noreferrer">
      🛠️ Create your own Choicer Voicer pack ↗
    </a>
  )
}

export function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

/** Date and time, so that two versions from the same day are different. */
export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** For example "made 3 Oct 2026, 14:05 · uploaded 5 Oct 2026, 09:12 by Ann". */
export function versionDates(pack: PackSummary): string {
  const parts: string[] = []
  if (pack.builtAt) parts.push(`made ${formatWhen(pack.builtAt)}`)
  const verb = pack.source.kind === 'upload' ? 'uploaded' : 'added'
  parts.push(`${verb} ${formatWhen(pack.createdAt)}${pack.source.uploader ? ` by ${pack.source.uploader}` : ''}`)
  return parts.join(' · ')
}

/** "Version 2 of 3 (newest)". The list is newest first, so the oldest version is version 1. */
export function versionLabel(index: number, count: number): string {
  return `Version ${count - index} of ${count}${index === 0 ? ' (newest)' : ''}`
}

/** Match score of a take or a dub (0..100). Shows nothing when the score is unknown. */
export function ScoreBadge({ score, label }: { score: number | null | undefined; label?: boolean }) {
  if (typeof score !== 'number') return null
  const tone = score >= 75 ? 'good' : score >= 35 ? 'mid' : 'low'
  return (
    <span className={`score score--${tone}`} title="How well the waveform and the timing match the original line (0 to 100)">
      🎯 {score}
      {label ? ` · ${scoreLabel(score)}` : ''}
    </span>
  )
}
