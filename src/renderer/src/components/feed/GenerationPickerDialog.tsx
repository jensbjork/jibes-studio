// Picks one finished clip from the library: the feed's clips (Venice's, the user's own, versions from Redigera) with
// a search and a "Källa" tab. Used by Sekvenser's "Från klippflödet…" / "Från Redigera…" and by Redigera's
// "Från klippflödet…".

import { useEffect, useMemo, useRef, useState } from 'react'
import { generationSource, generationTitle, sourceBadge, SOURCE_LABELS } from '@shared/generation-label'
import { queryGenerations } from '@shared/generation-filter'
import type { Generation, GenerationSource } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import Modal from '../pickers/Modal'
import { formatClipLength } from './feedText'
import { SearchIcon } from './icons'

interface Props {
  open: boolean
  title: string
  /** The sources offered (and the tabs shown); default every source. The first is selected when the dialog opens. */
  sources?: GenerationSource[]
  onClose: () => void
  onPicked: (g: Generation) => void
}

const ALL_SOURCES: GenerationSource[] = ['generated', 'import', 'edit']
/** The list shows this many at a time; a search narrows it. */
const PAGE = 120

/**
 * A modal list of the library's finished clips, newest first, as poster cards with their title, length and source;
 * a click picks one. Clips whose video is missing aren't offered.
 */
export default function GenerationPickerDialog({ open, title, sources, onClose, onPicked }: Props) {
  const offered = sources?.length ? sources : ALL_SOURCES
  const [list, setList] = useState<Generation[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<GenerationSource | 'all'>(offered.length === 1 ? offered[0] : 'all')
  const [limit, setLimit] = useState(PAGE)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    let current = true
    setList(undefined)
    setError(undefined)
    setQuery('')
    setLimit(PAGE)
    setTab(offered.length === 1 ? offered[0] : 'all')
    window.studio.listGenerations().then(
      (all) => current && setList(all),
      (e: unknown) => current && setError(ipcErrorMessage(e))
    )
    return () => {
      current = false
    }
    // The offered sources are a prop literal at the call sites; reopening is what reloads.
  }, [open])

  const finished = useMemo(
    () =>
      (list ?? []).filter(
        (g) => g.status === 'completed' && !!g.filePath && !g.fileMissing && offered.includes(generationSource(g))
      ),
    [list, offered.join()]
  )
  const counts = useMemo(() => {
    const m = new Map<GenerationSource, number>()
    for (const g of finished) m.set(generationSource(g), (m.get(generationSource(g)) ?? 0) + 1)
    return m
  }, [finished])
  const shown = useMemo(
    () =>
      queryGenerations(finished, {
        sort: 'newest',
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(tab !== 'all' ? { source: tab } : {})
      }),
    [finished, query, tab]
  )

  if (!open) return null

  const tabs: (GenerationSource | 'all')[] = offered.length > 1 ? ['all', ...offered] : []
  const tabLabel = (t: GenerationSource | 'all'): string => (t === 'all' ? 'Alla' : SOURCE_LABELS[t])

  return (
    <Modal title={title} onClose={onClose} maxWidth={760}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1">
            <SearchIcon
              size={12}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setLimit(PAGE)
              }}
              placeholder="Sök på prompt eller namn…"
              aria-label="Sök klipp"
              className="h-7 w-full rounded-md border border-line bg-raised pl-7 pr-2 text-[12px] outline-none focus:border-muted"
            />
          </div>
          {tabs.length > 0 && (
            <div
              role="tablist"
              aria-label="Källa"
              className="flex h-7 items-center rounded-md border border-line bg-panel p-0.5"
            >
              {tabs.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => {
                    setTab(t)
                    setLimit(PAGE)
                  }}
                  className={`flex h-full items-center gap-1 rounded-[5px] px-2.5 text-[12px] transition ${
                    tab === t ? 'bg-raised text-text shadow-sm shadow-black/40' : 'text-muted hover:text-text'
                  }`}
                >
                  {tabLabel(t)}
                  {t !== 'all' && <span className="text-[10px] text-muted">{counts.get(t) ?? 0}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {error ? (
          <p className="py-8 text-center text-accent select-text">{error}</p>
        ) : !list ? (
          <p className="py-8 text-center text-muted">Laddar klippen…</p>
        ) : shown.length === 0 ? (
          <p className="py-8 text-center text-muted">
            {query.trim()
              ? 'Inget klipp matchar sökningen.'
              : tab === 'import'
                ? 'Inga egna klipp än. Importera dem från Generera eller dra in dem i en sekvens.'
                : tab === 'edit'
                  ? 'Inga versioner från Redigera än.'
                  : 'Inga färdiga klipp än.'}
          </p>
        ) : (
          <>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2.5">
              {shown.slice(0, limit).map((g) => (
                <li key={g.id}>
                  <PickCard g={g} onPick={() => onPicked(g)} />
                </li>
              ))}
            </ul>
            {shown.length > limit && (
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE)}
                className="self-center rounded-md border border-line px-3 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                Visa fler ({shown.length - limit} till)
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function PickCard({ g, onPick }: { g: Generation; onPick: () => void }) {
  const badge = sourceBadge(g)
  const name = generationTitle(g, 80)
  return (
    <button
      type="button"
      onClick={onPick}
      title={generationTitle(g)}
      className="group block w-full overflow-hidden rounded-lg border border-line bg-panel text-left transition hover:border-muted focus-visible:border-muted focus-visible:outline-none"
    >
      <span className="relative block aspect-video bg-black">
        {g.thumbPath ? (
          <img
            src={mediaUrl(g.thumbPath)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full object-contain"
          />
        ) : (
          <video
            src={`${mediaUrl(g.filePath!)}#t=0.5`}
            preload="metadata"
            muted
            className="h-full w-full object-contain"
          />
        )}
        {badge && (
          <span
            title={badge.description}
            className="absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-px text-[10px] font-medium text-text"
          >
            {badge.label}
          </span>
        )}
        {g.videoDuration !== undefined && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-px text-[10px] tabular-nums text-text">
            {formatClipLength(g.videoDuration)}
          </span>
        )}
      </span>
      <span className="line-clamp-2 px-2 py-1.5 text-[11px] leading-snug text-muted group-hover:text-text">{name}</span>
    </button>
  )
}
