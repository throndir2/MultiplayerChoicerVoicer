import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  formatBytes,
  formatSeconds,
  type CatalogResponse,
  type ModDetails,
  type PackSummary,
} from '@mcv/shared'
import { Modal, PackCreatorLink, ProgressBar, percent, versionDates, versionLabel } from '../components/ui'
import { api } from '../lib/api'
import { useRoom } from '../lib/room'
import { uploadPack, type UploadItem } from '../lib/upload'

type Tab = 'gamebanana' | 'server' | 'upload' | 'link'

/** What the Library does with the chosen pack: use it now (host), add it to the queue (host), or suggest it (anyone). */
export type LibraryTarget = 'select' | 'queue' | 'suggest'

const TARGETS: Record<LibraryTarget, { path: string; title: string; action: string; done: string }> = {
  select: { path: 'source', title: 'Choose a pack', action: 'Use this pack', done: '' },
  queue: { path: 'queue', title: 'Add a pack to the queue', action: 'Add to the queue', done: 'Added to the queue' },
  suggest: { path: 'suggestions', title: 'Suggest a pack', action: 'Suggest this pack', done: 'Your suggestion is in the list' },
}

function useSource(target: LibraryTarget) {
  const { room, session, notify } = useRoom()
  return async (body: unknown): Promise<boolean> => {
    try {
      await api<unknown>(`/api/rooms/${room.code}/${TARGETS[target].path}`, { body, token: session.token })
      if (TARGETS[target].done) notify(TARGETS[target].done, 'info')
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The request failed')
      return false
    }
  }
}

function GameBananaTab({ onDone, target }: { onDone: () => void; target: LibraryTarget }) {
  const select = useSource(target)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState('new')
  const [hideRated, setHideRated] = useState(true)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [details, setDetails] = useState<ModDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState<number | null>(null)
  const [fileId, setFileId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => setPage(1), [debounced, category, sort, hideRated])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ page: String(page), pageSize: '24', sort, hideRated: String(hideRated) })
    if (debounced) params.set('q', debounced)
    if (category) params.set('category', category)
    setLoading(true)
    api<CatalogResponse>(`/api/catalog?${params.toString()}`, { signal: controller.signal })
      .then((value) => {
        setData(value)
        setLoading(false)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [debounced, category, sort, hideRated, page])

  async function openDetails(modId: number) {
    setDetailsLoading(modId)
    try {
      const value = await api<ModDetails>(`/api/catalog/mods/${modId}`)
      setDetails(value)
      const archives = value.files.filter((file) => file.isArchive)
      setFileId((archives[0] ?? value.files[0])?.id ?? null)
    } catch {
      setDetails(null)
    } finally {
      setDetailsLoading(null)
    }
  }

  async function choosePack() {
    if (!details || !fileId) return
    setBusy(true)
    if (await select({ kind: 'gamebanana', modId: details.id, fileId })) onDone()
    setBusy(false)
  }

  if (details) {
    const file = details.files.find((entry) => entry.id === fileId)
    return (
      <div className="mod-details">
        <button type="button" className="button button--small" onClick={() => setDetails(null)}>
          ← Back to the list
        </button>
        <div className="mod-details__head">
          <div>
            <h3>{details.name}</h3>
            <p className="muted">
              by {details.submitter} · ♥ {details.likes} · 👁 {details.views} · ⬇ {details.downloads}
            </p>
            <a href={details.profileUrl} target="_blank" rel="noreferrer">
              Open on GameBanana ↗
            </a>
          </div>
        </div>
        {details.images.length > 0 && (
          <div className="mod-details__images">
            {details.images.slice(0, 4).map((image) => (
              <img key={image} src={image} alt="" loading="lazy" />
            ))}
          </div>
        )}
        {details.description && <p>{details.description}</p>}
        {details.text && <p className="mod-details__text">{details.text}</p>}
        <h4>Files</h4>
        <ul className="file-list">
          {details.files.map((entry) => (
            <li key={entry.id}>
              <label>
                <input
                  type="radio"
                  name="file"
                  checked={fileId === entry.id}
                  disabled={!entry.isArchive}
                  onChange={() => setFileId(entry.id)}
                />
                <span>
                  <strong>{entry.name}</strong> · {formatBytes(entry.size)}
                  {entry.description && <span className="muted"> — {entry.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="button button--primary"
          disabled={!file || busy}
          onClick={() => void choosePack()}
        >
          {busy ? 'Starting…' : `${TARGETS[target].action}${file ? ` (${formatBytes(file.size)})` : ''}`}
        </button>
        <p className="hint">
          {target === 'suggest'
            ? 'Everybody sees your suggestion. The host decides which pack to play.'
            : target === 'queue'
              ? 'The server downloads and prepares the pack in the background. The browsers download it after the current pack.'
              : 'The server downloads and prepares the pack. Everybody in the room then gets the files.'}
        </p>
      </div>
    )
  }

  return (
    <div className="catalog">
      <div className="catalog__filters">
        <input
          type="search"
          placeholder="Search packs, for example: Hazbin, Shrek, SpongeBob…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {data?.categories.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name} ({entry.count})
            </option>
          ))}
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort">
          <option value="new">Newest</option>
          <option value="updated">Recently updated</option>
          <option value="likes">Most liked</option>
          <option value="views">Most viewed</option>
          <option value="name">Name</option>
        </select>
        <label className="toggle toggle--inline">
          <input type="checkbox" checked={hideRated} onChange={(event) => setHideRated(event.target.checked)} />
          <span>Hide rated content</span>
        </label>
      </div>
      {data?.syncing && (
        <p className="hint">The server is reading the GameBanana list ({data.total} packs so far). More appear soon.</p>
      )}
      {data && data.total === 0 && !loading && (
        <p className="muted">
          No packs found.
          {data.syncedAt === null && ' The list from GameBanana is not loaded yet. Try again in a minute.'}
        </p>
      )}
      <div className={`catalog__grid${loading ? ' is-loading' : ''}`}>
        {data?.items.map((item) => (
          <button
            type="button"
            key={item.id}
            className="mod-card"
            onClick={() => void openDetails(item.id)}
            disabled={detailsLoading !== null}
          >
            <div className="mod-card__thumb">
              {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span>🎬</span>}
              {detailsLoading === item.id && <div className="spinner spinner--small" />}
            </div>
            <div className="mod-card__body">
              <strong>{item.name}</strong>
              <span className="muted">
                {item.submitter} · {item.category}
              </span>
              <span className="muted">
                ♥ {item.likes} · 👁 {item.views}
              </span>
            </div>
          </button>
        ))}
      </div>
      {data && data.total > data.pageSize && (
        <div className="pager">
          <button type="button" className="button button--small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← Previous
          </button>
          <span>
            Page {page} of {Math.ceil(data.total / data.pageSize)}
          </span>
          <button
            type="button"
            className="button button--small"
            disabled={page * data.pageSize >= data.total}
            onClick={() => setPage(page + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

function ServerPackButton({
  pack,
  version,
  onSelect,
}: {
  pack: PackSummary
  version?: { index: number; count: number }
  onSelect: (pack: PackSummary) => void
}) {
  return (
    <button type="button" className="server-pack" onClick={() => onSelect(pack)}>
      {pack.iconUrl ? <img src={pack.iconUrl} alt="" loading="lazy" /> : <span className="server-pack__blank">🎬</span>}
      <span>
        <strong>{pack.title}</strong>
        <span className="muted">
          {pack.lineCount} lines · {pack.characterCount} characters · {formatSeconds(pack.duration)}
        </span>
        <span className="muted server-pack__dates">
          {version && <span className="badge">{versionLabel(version.index, version.count)}</span>}
          {versionDates(pack)}
        </span>
      </span>
    </button>
  )
}

function ServerTab({ onDone, target }: { onDone: () => void; target: LibraryTarget }) {
  const select = useSource(target)
  const [packs, setPacks] = useState<PackSummary[] | null>(null)
  useEffect(() => {
    api<{ packs: PackSummary[] }>('/api/packs')
      .then((value) => setPacks(value.packs))
      .catch(() => setPacks([]))
  }, [])
  if (!packs) return <div className="spinner" />
  if (packs.length === 0) return <p className="muted">No packs are on this server yet.</p>
  // The server sends all versions of a pack together, newest first.
  const groups: PackSummary[][] = []
  for (const pack of packs) {
    const last = groups[groups.length - 1]
    if (last && last[0]?.versionKey === pack.versionKey) last.push(pack)
    else groups.push([pack])
  }
  const choose = (pack: PackSummary) => void select({ kind: 'pack', packId: pack.id }).then((ok) => ok && onDone())
  return (
    <div className="server-packs">
      <p className="hint">These packs are already prepared on the server, so they start immediately.</p>
      {groups.map((group) =>
        group.length === 1 ? (
          <ServerPackButton key={group[0]?.id} pack={group[0] as PackSummary} onSelect={choose} />
        ) : (
          <div key={group[0]?.id} className="server-pack-group">
            <p className="server-pack-group__head">
              📚 <strong>{group[0]?.title}</strong>: {group.length} versions on this server (updates or alternates).
              Choose one.
            </p>
            {group.map((pack, index) => (
              <ServerPackButton key={pack.id} pack={pack} version={{ index, count: group.length }} onSelect={choose} />
            ))}
          </div>
        ),
      )}
    </div>
  )
}

function UploadTab({ onDone }: { onDone: () => void }) {
  const { room, session, notify } = useRoom()
  const [items, setItems] = useState<UploadItem[]>([])
  const [isPublic, setIsPublic] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
    folderInput.current?.setAttribute('directory', '')
  }, [])

  function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]
    setItems(
      files.map((file) => ({
        file,
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      })),
    )
  }

  async function start() {
    if (items.length === 0) return
    setProgress(0)
    try {
      await uploadPack(room.code, session.token, items, isPublic, setProgress)
      onDone()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The upload failed')
      setProgress(null)
    }
  }

  const total = items.reduce((sum, item) => sum + item.file.size, 0)

  return (
    <div className="upload">
      <p>
        Upload a Choicer Voicer pack as a <strong>.zip</strong>, <strong>.7z</strong> or <strong>.rar</strong> file, or
        choose the pack folder (the folder with <code>_pack_info.ini</code> and <code>dub_video.ogv</code>).
      </p>
      <div className="upload__pickers">
        <label className="button">
          Choose an archive
          <input type="file" accept=".zip,.7z,.rar" hidden onChange={onFiles} />
        </label>
        <label className="button">
          Choose a folder
          <input ref={folderInput} type="file" multiple hidden onChange={onFiles} />
        </label>
      </div>
      {items.length > 0 && (
        <p className="muted">
          {items.length === 1 ? items[0]?.path : `${items.length} files`} · {formatBytes(total)}
        </p>
      )}
      <label className="toggle">
        <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
        <span>Let other rooms on this server use the pack too</span>
      </label>
      {progress !== null ? (
        <ProgressBar value={progress} label={`Uploading ${percent(progress)}`} />
      ) : (
        <button type="button" className="button button--primary" disabled={items.length === 0} onClick={() => void start()}>
          Upload and use
        </button>
      )}
      <p className="hint">Large files upload in small parts. If your connection breaks, the upload continues from the last part.</p>
      <div className="upload__creator">
        <p className="muted">No pack yet? Make one from any video or YouTube link with the free Windows app.</p>
        <PackCreatorLink className="button button--small" />
      </div>
    </div>
  )
}

function LinkTab({ onDone, target }: { onDone: () => void; target: LibraryTarget }) {
  const select = useSource(target)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="link-import"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        void select({ kind: 'url', url: url.trim() }).then((ok) => {
          setBusy(false)
          if (ok) onDone()
        })
      }}
    >
      <p>Paste a GameBanana mod page, or a direct download link to a pack archive.</p>
      <input
        type="url"
        required
        placeholder="https://gamebanana.com/mods/123456"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <button className="button button--primary" disabled={busy || !url}>
        {busy ? 'Starting…' : target === 'select' ? 'Import' : TARGETS[target].action}
      </button>
      <p className="hint">
        Direct links work from GameBanana, GitHub, Dropbox, Google Drive and Discord. For other sites, download the file
        and upload it.
      </p>
    </form>
  )
}

export function Library({ onClose, target = 'select' }: { onClose: () => void; target?: LibraryTarget }) {
  const [tab, setTab] = useState<Tab>('gamebanana')
  const tabs: { id: Tab; label: string }[] = [
    { id: 'gamebanana', label: 'GameBanana' },
    { id: 'server', label: 'On this server' },
    ...(target === 'select' ? [{ id: 'upload' as const, label: 'Upload' }] : []),
    { id: 'link', label: 'Link' },
  ]
  return (
    <Modal title={TARGETS[target].title} onClose={onClose} wide>
      <div className="tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`tab${tab === entry.id ? ' is-active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {tab === 'gamebanana' && <GameBananaTab onDone={onClose} target={target} />}
      {tab === 'server' && <ServerTab onDone={onClose} target={target} />}
      {tab === 'upload' && <UploadTab onDone={onClose} />}
      {tab === 'link' && <LinkTab onDone={onClose} target={target} />}
    </Modal>
  )
}
