// Picks a video to use as a reference: a finished clip from Media (Venice's, an own clip, a version from the Editor),
// a take of a sequence clip (by sequence and clip), or an exported film. Each card says how long it is and whether it
// still fits the model family's reference videos; a click adds it with its window (the form decides the window).

import { useEffect, useMemo, useState } from 'react'
import { generationTitle, sourceBadge } from '@shared/generation-label'
import { queryGenerations } from '@shared/generation-filter'
import type { ExportSummary, Generation, Sequence, SequenceSummary } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import { formatClipLength } from '../feed/feedText'
import { SearchIcon } from '../feed/icons'
import Segmented from '../ui/Segmented'
import Modal from './Modal'
import { exportVideoFacts, generationVideoFacts } from './videoFacts'
import type { VideoCandidate, VideoFacts } from './videoRefs'

/** The dialog's tabs: Media's clips, a sequence's takes, the exported films. */
export type VideoSourceTab = 'media' | 'takes' | 'films'

const TABS: { id: VideoSourceTab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'takes', label: 'Takes' },
  { id: 'films', label: 'Films' }
]

/** The list shows this many at a time; a search narrows it. */
const PAGE = 90

interface Props {
  open: boolean
  /** The tab it opens on. */
  tab: VideoSourceTab
  /** A sequence clip's sequence: the Takes tab opens on it. */
  sequenceId?: string
  /** Whether a video of this length (seconds; undefined when unknown) at this path can be added now, and why not. */
  fits: (path: string, duration: number | undefined) => { fits: boolean; reason?: string }
  onClose: () => void
  /** The video picked, with what is known about it. */
  onPick: (candidate: VideoCandidate, facts: VideoFacts) => void
}

/** A card of the dialog: what it shows and what picking it adds. */
interface Choice {
  key: string
  path: string
  title: string
  /** Shown over the poster ("Take", "Own", "Film"). */
  badge?: string
  duration?: number
  thumbPath?: string
  facts: VideoFacts
}

function generationChoice(g: Generation, takeName?: string): Choice {
  const badge = g.segmentId ? 'Take' : sourceBadge(g)?.label
  return {
    key: g.id,
    path: g.filePath!,
    title: takeName ? `${takeName} · ${generationTitle(g, 60)}` : generationTitle(g, 80),
    badge,
    duration: g.videoDuration,
    thumbPath: g.thumbPath,
    facts: generationVideoFacts(g, takeName)
  }
}

function filmChoice(e: ExportSummary): Choice {
  return {
    key: e.id,
    path: e.path,
    title: e.sequenceName ? `“${e.sequenceName}”` : 'Exported film',
    badge: 'Film',
    duration: e.duration,
    facts: exportVideoFacts(e)
  }
}

const finished = (g: Generation): boolean => g.status === 'completed' && !!g.filePath && !g.fileMissing

/** The dialog: tabs, a search (Media) or a sequence (Takes), and the cards. */
export default function ReferenceVideoDialog({ open, tab: initialTab, sequenceId, fits, onClose, onPick }: Props) {
  const [tab, setTab] = useState<VideoSourceTab>(initialTab)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [error, setError] = useState<string>()
  const [generations, setGenerations] = useState<Generation[]>()
  const [films, setFilms] = useState<ExportSummary[]>()
  const [sequences, setSequences] = useState<SequenceSummary[]>()
  const [chosenSequence, setChosenSequence] = useState<string | undefined>(sequenceId)
  const [sequence, setSequence] = useState<Sequence>()

  useEffect(() => {
    if (!open) return
    setTab(initialTab)
    setQuery('')
    setLimit(PAGE)
    setError(undefined)
    setChosenSequence(sequenceId)
  }, [open, initialTab])

  useEffect(() => {
    if (!open) return
    let current = true
    const fail = (e: unknown) => current && setError(ipcErrorMessage(e))
    if (tab === 'media' && !generations) window.studio.listGenerations().then((l) => current && setGenerations(l), fail)
    if (tab === 'films' && !films) {
      window.studio
        .listExports()
        .then((l) => current && setFilms([...l].filter((e) => e.exists).sort((a, b) => b.createdAt - a.createdAt)), fail)
    }
    if (tab === 'takes' && !sequences) {
      window.studio.listSequences().then(
        (l) => {
          if (!current) return
          const sorted = [...l].sort((a, b) => b.updatedAt - a.updatedAt)
          setSequences(sorted)
          setChosenSequence((id) => (id && sorted.some((s) => s.id === id) ? id : sorted[0]?.id))
        },
        fail
      )
    }
    return () => {
      current = false
    }
  }, [open, tab])

  useEffect(() => {
    if (!open || tab !== 'takes' || !chosenSequence) return
    let current = true
    setSequence(undefined)
    window.studio.getSequence(chosenSequence).then(
      (s) => current && setSequence(s),
      (e: unknown) => current && setError(ipcErrorMessage(e))
    )
    return () => {
      current = false
    }
  }, [open, tab, chosenSequence])

  const mediaChoices = useMemo(() => {
    const list = (generations ?? []).filter(finished)
    const shown = queryGenerations(list, { sort: 'newest', ...(query.trim() ? { query: query.trim() } : {}) })
    return shown.map((g) => generationChoice(g))
  }, [generations, query])

  const takeGroups = useMemo(
    () =>
      (sequence?.segments ?? []).flatMap((segment, i) => {
        const name = `Clip ${i + 1} in “${sequence!.name}”`
        const takes = segment.takes.filter(finished)
        return takes.length ? [{ key: segment.id, name, choices: takes.map((g) => generationChoice(g, name)) }] : []
      }),
    [sequence]
  )

  const filmChoices = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('en')
    return (films ?? []).filter((e) => !q || (e.sequenceName ?? '').toLocaleLowerCase('en').includes(q)).map(filmChoice)
  }, [films, query])

  if (!open) return null

  const loading =
    !error && ((tab === 'media' && !generations) || (tab === 'films' && !films) || (tab === 'takes' && !sequences))

  const grid = (choices: Choice[]) => (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
      {choices.map((c) => (
        <li key={c.key}>
          <ChoiceCard choice={c} fit={fits(c.path, c.duration)} onPick={() => onPick({ path: c.path, duration: c.duration, name: c.title }, c.facts)} />
        </li>
      ))}
    </ul>
  )

  let body
  if (error) body = <p className="py-8 text-center text-accent select-text">{error}</p>
  else if (loading) body = <p className="py-8 text-center text-muted">Loading…</p>
  else if (tab === 'media') {
    body = mediaChoices.length ? (
      <>
        {grid(mediaChoices.slice(0, limit))}
        {mediaChoices.length > limit && <MoreButton count={mediaChoices.length - limit} onClick={() => setLimit((n) => n + PAGE)} />}
      </>
    ) : (
      <p className="py-8 text-center text-muted">{query.trim() ? 'No clip matches the search.' : 'No finished clips yet.'}</p>
    )
  } else if (tab === 'films') {
    body = filmChoices.length ? (
      grid(filmChoices)
    ) : (
      <p className="py-8 text-center text-muted">
        {query.trim() ? 'No film matches the search.' : 'No exported films yet. Export a sequence and it shows up here.'}
      </p>
    )
  } else if (!sequences?.length) {
    body = <p className="py-8 text-center text-muted">No sequences yet.</p>
  } else if (!sequence) {
    body = <p className="py-8 text-center text-muted">Loading the takes…</p>
  } else {
    body = takeGroups.length ? (
      <div className="space-y-4">
        {takeGroups.map((group) => (
          <section key={group.key}>
            <h3 className="mb-1.5 text-[11px] font-medium text-muted">{group.name}</h3>
            {grid(group.choices)}
          </section>
        ))}
      </div>
    ) : (
      <p className="py-8 text-center text-muted">No finished takes in this sequence yet.</p>
    )
  }

  return (
    <Modal
      title="Add a reference video"
      subtitle="The video steers the motion, the camera and the style – it isn’t edited or shown in the clip."
      onClose={onClose}
      maxWidth={760}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            role="tablist"
            ariaLabel="Where the video comes from"
            value={tab}
            onChange={(t) => {
              setTab(t)
              setLimit(PAGE)
            }}
            options={TABS.map((t) => ({ value: t.id, label: t.label }))}
          />
          {tab === 'takes' ? (
            sequences && sequences.length > 0 && (
              <select
                value={chosenSequence ?? ''}
                onChange={(e) => setChosenSequence(e.target.value)}
                aria-label="Sequence"
                className="h-7 min-w-40 flex-1 rounded-md border border-line bg-raised px-2 text-[12px] outline-none focus:border-muted"
              >
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )
          ) : (
            <div className="relative min-w-40 flex-1">
              <SearchIcon size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setLimit(PAGE)
                }}
                placeholder={tab === 'films' ? 'Search sequences…' : 'Search prompts and names…'}
                aria-label={tab === 'films' ? 'Search films' : 'Search clips'}
                className="h-7 w-full rounded-md border border-line bg-raised pl-7 pr-2 text-[12px] outline-none focus:border-muted"
              />
            </div>
          )}
        </div>
        {body}
      </div>
    </Modal>
  )
}

function MoreButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2.5 self-center rounded-md border border-line px-3 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
    >
      Show more ({count} more)
    </button>
  )
}

function ChoiceCard({ choice: c, fit, onPick }: { choice: Choice; fit: { fits: boolean; reason?: string }; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!fit.fits}
      title={fit.fits ? c.title : `${c.title} – ${fit.reason}`}
      className="group block w-full overflow-hidden rounded-lg border border-line bg-panel text-left transition enabled:hover:border-muted focus-visible:border-muted focus-visible:outline-none disabled:opacity-45"
    >
      <span className="relative block aspect-video bg-black">
        {c.thumbPath ? (
          <img src={mediaUrl(c.thumbPath)} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-contain" />
        ) : (
          <video src={`${mediaUrl(c.path)}#t=0.5`} preload="metadata" muted className="h-full w-full object-contain" />
        )}
        {c.badge && (
          <span className="absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-px text-[10px] font-medium text-text">{c.badge}</span>
        )}
        {c.duration !== undefined && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-px text-[10px] tabular-nums text-text">
            {formatClipLength(c.duration)}
          </span>
        )}
      </span>
      <span className="line-clamp-2 px-2 pt-1.5 text-[11px] leading-snug text-muted group-enabled:group-hover:text-text">{c.title}</span>
      <span className="block px-2 pb-1.5 text-[10px] text-accent">{fit.fits ? ' ' : fit.reason}</span>
    </button>
  )
}
