import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { workKey, type Still } from '@shared/types'
import type { Navigate } from '../../lib/navigation'
import { useIsUnseen, useSeenWhenVisible } from '../../lib/work'
import FilterMenu from '../feed/FilterMenu'
import { FilmIcon } from '../icons'
import { formatStillTime, stillSourceLabel, useStills } from '../images/imageModels'
import StillThumb from '../images/StillThumb'
import StillViewer from '../images/StillViewer'
import { useSequenceList } from '../sequences/useSequence'
import { StoryboardIcon } from '../storyboards/icons'
import { useStoryboardList } from '../storyboards/useStoryboard'
import NewPictures from '../work/NewPictures'
import { NewChip } from '../work/StatusMark'
import { CountLine, MediaToolbar, NoticeRow, SearchField } from './ui'

// Bilder: every still in the library – made with an image model, uploaded, or a frame saved from a clip – newest
// first, wherever it belongs: a sequence, a storyboard, or Referensbilder for one with no place. Opened in the
// picture viewer, which steps through what the filters show.

type SourceChoice = Still['source']
type PlaceChoice = 'sequence' | 'storyboard' | 'loose'

interface PictureFilters {
  query: string
  source?: SourceChoice
  place?: PlaceChoice
}

const NO_FILTERS: PictureFilters = { query: '' }

const SOURCE_OPTIONS: { id: SourceChoice; label: string; text: string }[] = [
  { id: 'generated', label: 'Skapade', text: 'Bilder gjorda med en bildmodell' },
  { id: 'upload', label: 'Uppladdade', text: 'Dina egna bilder' },
  { id: 'frame', label: 'Bildrutor', text: 'Bildrutor sparade ur ett klipp' }
]

const PLACE_OPTIONS: { id: PlaceChoice; label: string; text: string }[] = [
  { id: 'sequence', label: 'Sekvenser', text: 'Bilder som hör till en sekvens' },
  { id: 'storyboard', label: 'Storyboards', text: 'Bilder som hör till en storyboard' },
  { id: 'loose', label: 'Lösa bilder', text: 'Bilder i Referensbilder, utan sekvens eller storyboard' }
]

/** Like the clip feed's: kept while Studio runs (switching views keeps them), never across a restart. */
let rememberedFilters: PictureFilters = NO_FILTERS

/** Tiles rendered at first; more are added as the grid scrolls towards its end. */
const PAGE = 120

/** Where a still belongs, as the grid says it. */
interface Place {
  kind: PlaceChoice
  id?: string
  name: string
}

const LOOSE: Place = { kind: 'loose', name: 'Referensbilder' }

interface OpenRequest {
  stillId: string
  source?: 'agent'
}

interface Props {
  /** The Mediabank's tabs, at the start of the header. */
  tabs: ReactNode
  navigate: Navigate
  /** Open this still in the viewer; `source: 'agent'` doesn't mark it seen by showing it. */
  openRequest?: OpenRequest
  onOpenRequestHandled: () => void
}

export default function PicturesTab({ tabs, navigate, openRequest, onOpenRequestHandled }: Props) {
  const { stills, loaded } = useStills()
  const { sequences } = useSequenceList()
  const { storyboards } = useStoryboardList()

  // A still's sequenceId is a sequence's or a storyboard's id; the lists say which, and its name.
  const places = useMemo(() => {
    const map = new Map<string, Place>()
    for (const s of sequences ?? []) map.set(s.id, { kind: 'sequence', id: s.id, name: s.name })
    for (const b of storyboards ?? []) map.set(b.id, { kind: 'storyboard', id: b.id, name: b.name })
    return map
  }, [sequences, storyboards])
  const placesLoaded = sequences !== undefined && storyboards !== undefined
  const placeOf = (s: Still): Place | undefined =>
    !s.sequenceId ? LOOSE : (places.get(s.sequenceId) ?? (placesLoaded ? LOOSE : undefined))

  const [filters, setFiltersState] = useState<PictureFilters>(rememberedFilters)
  const setFilters = (f: PictureFilters) => {
    setFiltersState(f)
    rememberedFilters = f
  }
  const set = (patch: Partial<PictureFilters>) => setFilters({ ...filters, ...patch })
  const deferred = useDeferredValue(filters)
  const filtering = !!(filters.query.trim() || filters.source || filters.place)

  const shown = useMemo(() => {
    const needle = deferred.query.trim().toLocaleLowerCase('sv')
    return stills.filter((s) => {
      if (deferred.source && s.source !== deferred.source) return false
      if (deferred.place && placeOf(s)?.kind !== deferred.place) return false
      return !needle || s.prompt.toLocaleLowerCase('sv').includes(needle)
    })
  }, [stills, deferred, places, placesLoaded])

  const sourceCounts = useMemo(() => countBy(stills, (s) => s.source), [stills])
  const placeCounts = useMemo(() => countBy(stills, (s) => placeOf(s)?.kind), [stills, places, placesLoaded])
  const count = filtering ? `${shown.length} av ${picturesText(stills.length)}` : picturesText(stills.length)

  const [notice, setNotice] = useState<string>()
  const [opened, setOpened] = useState<{ still: Still; byAgent: boolean }>()

  // Pågår och klart or an agent showing a picture: opened in the viewer, lifting filters that hide it (with a note).
  // One made a moment ago may not be in the list yet, so it is looked up once more before it counts as gone.
  const handled = useRef<OpenRequest>(undefined)
  useEffect(() => {
    if (!openRequest || !loaded || handled.current === openRequest) return
    handled.current = openRequest
    const request = openRequest
    const show = (still: Still | undefined) => {
      if (!still) {
        setNotice('Bilden finns inte längre i biblioteket.')
        return
      }
      if (filtering && !shown.some((s) => s.id === still.id)) {
        setFilters(NO_FILTERS)
        setNotice('Filtren dolde bilden, så de är borttagna.')
      }
      setOpened({ still, byAgent: request.source === 'agent' })
    }
    const found = stills.find((s) => s.id === request.stillId)
    if (found) {
      show(found)
      onOpenRequestHandled()
      return
    }
    window.studio.listStills().then(
      (all) => show(all.find((s) => s.id === request.stillId)),
      () => show(undefined)
    )
    onOpenRequestHandled()
  }, [openRequest, loaded])

  // ⌘F searches the pictures.
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.defaultPrevented && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Render a page at a time; the sentinel near the end asks for the next one.
  const [limit, setLimit] = useState(PAGE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const filterKey = JSON.stringify(deferred)
  useEffect(() => {
    setLimit(PAGE)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [filterKey])
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root) return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setLimit((n) => n + PAGE), {
      root,
      rootMargin: '800px 0px'
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [limit, shown.length])

  const open = useCallback((still: Still) => setOpened({ still, byAgent: false }), [])
  const goTo = (place: Place) => {
    if (!place.id) return
    if (place.kind === 'storyboard') navigate('storyboards', { type: 'open-storyboard', storyboardId: place.id })
    else navigate('sequences', { type: 'open-sequence', sequenceId: place.id })
  }

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      <MediaToolbar
        tabs={tabs}
        below={
          <>
            <FilterMenu
              title="Källa"
              value={filters.source}
              valueLabel={SOURCE_OPTIONS.find((o) => o.id === filters.source)?.label}
              options={SOURCE_OPTIONS.map((o) => ({ id: o.id, label: o.label, text: o.text, hint: sourceCounts.get(o.id) }))}
              onChange={(source) => set({ source })}
              allLabel="Alla"
            />
            <FilterMenu
              title="Plats"
              value={filters.place}
              valueLabel={PLACE_OPTIONS.find((o) => o.id === filters.place)?.label}
              options={PLACE_OPTIONS.map((o) => ({ id: o.id, label: o.label, text: o.text, hint: placeCounts.get(o.id) }))}
              onChange={(place) => set({ place })}
              allLabel="Alla"
            />
            {filtering && (
              <button
                type="button"
                onClick={() => setFilters(NO_FILTERS)}
                className="no-drag ml-1 rounded px-1.5 py-1 text-[12px] text-muted underline-offset-2 hover:text-text hover:underline"
              >
                Rensa filter
              </button>
            )}
            <CountLine text={loaded ? count : ''} />
          </>
        }
      >
        <SearchField
          value={filters.query}
          onChange={(query) => set({ query })}
          placeholder="Sök i bildernas prompter…"
          inputRef={searchRef}
          onArrowDown={() => scrollRef.current?.querySelector<HTMLElement>('[role="button"]')?.focus()}
        />
      </MediaToolbar>
      {/* New pictures are marked in the grid; one that couldn't be made has only this place to say so. */}
      <NewPictures view="media" failuresOnly />
      {notice && <NoticeRow text={notice} onClose={() => setNotice(undefined)} />}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
        {!loaded ? null : stills.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <p className="max-w-sm leading-relaxed">
              Inga bilder än. Bilder du skapar, laddar upp eller sparar ur ett klipp – i sekvenser, storyboards och
              Generera – hamnar här.
            </p>
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-muted">
            <p>Inga bilder matchar filtren.</p>
            <button
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
              className="text-text underline-offset-2 hover:underline"
            >
              Rensa filter
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-5">
              {shown.slice(0, limit).map((s) => (
                <PictureTile key={s.id} still={s} place={placeOf(s)} onOpen={open} paused={!!opened} />
              ))}
            </div>
            {shown.length > limit && <div ref={sentinelRef} className="h-px" />}
          </>
        )}
      </div>

      {opened && (
        <StillViewer
          still={opened.still}
          stills={shown}
          onClose={() => setOpened(undefined)}
          deletable
          openedByAgent={opened.byAgent}
          actions={(s) => {
            const place = placeOf(s)
            if (!place?.id) return null
            return (
              <button
                type="button"
                onClick={() => goTo(place)}
                title={`Öppna ”${place.name}”`}
                className="rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text"
              >
                {place.kind === 'storyboard' ? 'Gå till storyboarden' : 'Gå till sekvensen'}
              </button>
            )
          }}
        />
      )}
    </div>
  )
}

function countBy<T, K>(items: readonly T[], key: (item: T) => K | undefined): Map<K, number> {
  const counts = new Map<K, number>()
  for (const item of items) {
    const k = key(item)
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

function picturesText(n: number): string {
  return n === 1 ? '1 bild' : `${n} bilder`
}

/**
 * One still in the grid: the picture, what it is (the prompt, or what kind of picture) and where it belongs. A new
 * one is marked "Ny" and counts as seen once it has been on screen a moment; the mark stays while the grid is up, so
 * it can still be found. Not while the viewer covers the grid (`paused`).
 */
const PictureTile = memo(function PictureTile({
  still,
  place,
  onOpen,
  paused
}: {
  still: Still
  place?: Place
  onOpen: (still: Still) => void
  paused: boolean
}) {
  const key = workKey.still(still.id)
  const unseen = useIsUnseen(key)
  const [wasNew, setWasNew] = useState(unseen)
  useEffect(() => {
    if (unseen) setWasNew(true)
  }, [unseen])
  const ref = useRef<HTMLDivElement>(null)
  useSeenWhenVisible(ref, paused ? undefined : key)

  const label = still.source === 'generated' && still.prompt.trim() ? still.prompt.trim() : stillSourceLabel(still)
  return (
    <figure className="min-w-0">
      <div ref={ref} className="relative">
        <StillThumb still={still} onOpen={onOpen} className="aspect-video w-full" />
        {(unseen || wasNew) && (
          <NewChip variant="overlay" title="Ny bild, inte tittad på än" className="pointer-events-none absolute left-1.5 top-1.5" />
        )}
      </div>
      <figcaption className="mt-1.5 min-w-0 leading-snug">
        <p className="truncate text-[12px] text-text" title={still.prompt || undefined}>
          {label}
        </p>
        <p className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
          {place?.kind === 'sequence' && <FilmIcon size={11} />}
          {place?.kind === 'storyboard' && <StoryboardIcon size={11} />}
          <span className="min-w-0 truncate" title={place ? placeTitle(place) : undefined}>
            {place?.name ?? '…'}
          </span>
          <span className="shrink-0">· {formatStillTime(still.createdAt)}</span>
        </p>
      </figcaption>
    </figure>
  )
})

function placeTitle(place: Place): string {
  if (place.kind === 'sequence') return `I sekvensen ”${place.name}”`
  if (place.kind === 'storyboard') return `I storyboarden ”${place.name}”`
  return 'I Referensbilder – hör inte till någon sekvens eller storyboard'
}
