import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatBytes, type PackManifest } from '@mcv/shared'
import { api } from '../lib/api'
import { assets } from '../lib/assets'
import {
  clearOnLeave,
  groupStored,
  packName,
  rememberPackName,
  setClearOnLeave,
  type StoredGroup,
} from '../lib/storage'
import { Modal } from './ui'

const DAY_MS = 24 * 3_600_000
const lookedUp = new Set<string>()

export function StorageButton({
  inUse = [],
  className = 'button button--small button--ghost',
  label = '💾 Downloaded files',
}: {
  inUse?: string[]
  className?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        title="See and delete the files that this site keeps on your computer"
        aria-label="Downloaded files"
      >
        {label}
      </button>
      {open && createPortal(<StoragePanel inUse={inUse} onClose={close} />, document.body)}
    </>
  )
}

function groupTitle(group: StoredGroup): string {
  if (group.packId) return packName(group.packId) ?? `Pack ${group.packId}`
  if (group.key === 'recordings') return 'Recordings of players'
  return 'Other files'
}

function lastUsedText(lastUsed: number): string {
  if (!lastUsed) return 'not used recently'
  const days = Math.floor((Date.now() - lastUsed) / DAY_MS)
  if (days <= 0) return 'used today'
  return days === 1 ? 'used 1 day ago' : `used ${days} days ago`
}

function StoragePanel({ inUse, onClose }: { inUse: string[]; onClose: () => void }) {
  const [groups, setGroups] = useState<StoredGroup[] | null | undefined>(undefined)
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [leave, setLeave] = useState(clearOnLeave)
  const [, setNamesVersion] = useState(0)

  const refresh = useCallback(async () => {
    const files = await assets.listStored()
    setGroups(files ? groupStored(files) : null)
    setEstimate(await assets.usage())
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // Files downloaded before the names were remembered: ask the server for the title.
  useEffect(() => {
    for (const group of groups ?? []) {
      const id = group.packId
      if (!id || packName(id) || lookedUp.has(id)) continue
      lookedUp.add(id)
      void api<PackManifest>(`/api/packs/${encodeURIComponent(id)}`)
        .then((manifest) => {
          rememberPackName(manifest.id, manifest.title)
          setNamesVersion((value) => value + 1)
        })
        .catch(() => undefined)
    }
  }, [groups])

  async function remove(targets: StoredGroup[], all: boolean) {
    const used = targets.some((group) => inUse.includes(group.key))
    const first = targets[0]
    const question = all
      ? 'Delete all files that this site downloaded to this computer?'
      : `Delete the files of "${first ? groupTitle(first) : ''}"?`
    const extra = used ? '\n\nThis room uses some of these files. They download again at once.' : ''
    if (!window.confirm(question + extra)) return
    setBusy(true)
    try {
      if (all) await assets.clearAll()
      else await assets.deleteFiles((path) => targets.some((group) => group.match(path)))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const total = groups?.reduce((sum, group) => sum + group.size, 0) ?? 0

  return (
    <Modal title="Downloaded files" onClose={onClose}>
      <p className="muted">
        This site keeps pack files and recordings in its private storage in your browser, so the game plays without
        delays. The files are not in your Downloads folder. Files that you do not use for 7 days are deleted
        automatically.
      </p>
      {groups === undefined && <p>Reading the files…</p>}
      {groups === null && <p>This browser does not keep files for this site. Nothing is stored on your computer.</p>}
      {groups && (
        <>
          <p>
            On this computer: <strong>{formatBytes(total)}</strong>
          </p>
          {estimate && estimate.usage > 0 && (
            <p className="hint">The browser reports {formatBytes(estimate.usage)} for all data of this site.</p>
          )}
          {groups.length === 0 ? (
            <p className="muted">No files are stored.</p>
          ) : (
            <ul className="storage-list">
              {groups.map((group) => (
                <li key={group.key} className="storage-list__item">
                  <div className="storage-list__info">
                    <strong>{groupTitle(group)}</strong>
                    {inUse.includes(group.key) && <span className="storage-list__tag">In this room</span>}
                    <span className="hint">
                      {formatBytes(group.size)} · {group.count} {group.count === 1 ? 'file' : 'files'} ·{' '}
                      {lastUsedText(group.lastUsed)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button--tiny button--danger"
                    disabled={busy}
                    onClick={() => void remove([group], false)}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="button-row">
            <button
              type="button"
              className="button button--small button--danger"
              disabled={busy || groups.length === 0}
              onClick={() => void remove(groups, true)}
            >
              Delete all
            </button>
          </div>
        </>
      )}
      <label className="toggle">
        <input
          type="checkbox"
          checked={leave}
          onChange={(event) => {
            setClearOnLeave(event.target.checked)
            setLeave(event.target.checked)
          }}
        />
        <span>Delete all downloaded files when I leave a room</span>
      </label>
    </Modal>
  )
}
