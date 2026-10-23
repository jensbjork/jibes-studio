import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { workKey, type Still } from '@shared/types'
import { useFindShortcut } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { useIsUnseen, useSeenWhenVisible } from '../../lib/work'
import { narrows } from '../feed/feedFilter'
import FilterMenu from '../feed/FilterMenu'
import { FilmIcon, PictureIcon } from '../icons'
import { formatStillTime, stillSourceLabel, useStills } from '../images/imageModels'
import StillThumb from '../images/StillThumb'
import StillViewer from '../images/StillViewer'
import { useSequenceList } from '../sequences/useSequence'
import { StoryboardIcon } from '../storyboards/icons'
import { useStoryboardList } from '../storyboards/useStoryboard'
import EmptyState from '../ui/EmptyState'
import NewPictures from '../work/NewPictures'
import { NewChip } from '../work/StatusMark'
import { CountLine, MEDIA_CAPTION, MEDIA_CARD, MediaToolbar, NoticeRow, SearchField } from './ui'

// Images: every still in the library – made with an image model, one of the user's own, or a frame saved from a
// clip – newest first, wherever it belongs: a sequence, a storyboard, or Reference images for one with no place.
// Opened in the picture viewer, which steps through what the filters show. The filters are named as on Clips.

type SourceChoice = Still['source']
type PlaceChoice = 'sequence' | 'storyboard' | 'loose'

interface PictureFilters {
  query: string
  source?: SourceChoice
  place?: PlaceChoice
}

const NO_FILTERS: PictureFilters = { query: '' }

const SOURCE_OPTIONS: { id: SourceChoice; label: string; text: string }[] = [
  { id: 'generated', label: 'Created', text: 'Images made with an image model' },
  { id: 'upload', label: 'Own images', text: 'Your own images' },
  { id: 'frame', label: 'Frames', text: 'Frames saved from a clip' }
]

const PLACE_OPTIONS: { id: PlaceChoice; label: string; text: string }[] = [
  { id: 'sequence', label: 'Sequences', text: 'Images that belong to a sequence' },
  { id: 'storyboard', label: 'Storyboards', text: 'Images that belong to a storyboard' },
  { id: 'loose', label: 'Reference images', text: 'Images in “Reference images”, with no sequence or storyboard' }
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

const LOOSE: Place = { kind: 'loose', name: 'Reference images' }

interface OpenRequest {
  stillId: string
  source?: 'agent'
}

interface Props {
  /** Media's tabs, at the start of the header. */
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
    const needle = deferred.query.trim().toLocaleLowerCase('en')
    return stills.filter((s) => {
      if (deferred.source && s.source !== deferred.source) return false
      if (deferred.place && placeOf(s)?.kind !== deferred.place) return false
      return !needle || s.prompt.toLocaleLowerCase('en').includes(needle)
    })
  }, [stills, deferred, places, placesLoaded])

  const sourceCounts = useMemo(() => countBy(stills, (s) => s.source), [stills])
  const placeCounts = useMemo(() => countBy(stills, (s) => placeOf(s)?.kind), [stills, places, placesLoaded])
  // A filter shows while it is set or can narrow the grid; Placement only once the sequences and storyboards are
  // known, so it doesn't flash in while they load.
  const showSource = filters.source !== undefined || narrows(sourceCounts, stills.length)
  const showPlace = filters.place !== undefined || (placesLoaded && narrows(placeCounts, stills.length))
  const count = filtering ? `${shown.length} of ${picturesText(stills.length)}` : picturesText(stills.length)

  const [notice, setNotice] = useState<string>()
  const [opened, setOpened] = useState<{ still: Still; byAgent: boolean }>()

  // Activity or an agent showing a picture: opened in the viewer, lifting filters that hide it (with a note).
  // One made a moment ago may not be in the list yet, so it is looked up once more before it counts as gone.
  const handled = useRef<OpenRequest>(undefined)
  useEffect(() => {
    if (!openRequest || !loaded || handled.current === openRequest) return
    handled.current = openRequest
    const request = openRequest
    const show = (still: Still | undefined) => {
      if (!still) {
        setNotice('The image is no longer in the library.')
        return
      }
      if (filtering && !shown.some((s) => s.id === still.id)) {
        setFilters(NO_FILTERS)
        setNotice('The filters hid the image, so they were cleared.')
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

  // ⌘F searches the pictures (not while the viewer is open over them).
  const searchRef = useRef<HTMLInputElement>(null)
  useFindShortcut(searchRef)

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
            {showSource && (
              <FilterMenu
                title="Source"
                value={filters.source}
                valueLabel={SOURCE_OPTIONS.find((o) => o.id === filters.source)?.label}
                options={SOURCE_OPTIONS.map((o) => ({ id: o.id, label: o.label, text: o.text, hint: sourceCounts.get(o.id) }))}
                onChange={(source) => set({ source })}
                allLabel="All"
              />
            )}
            {showPlace && (
              <FilterMenu
                title="Placement"
                value={filters.place}
                valueLabel={PLACE_OPTIONS.find((o) => o.id === filters.place)?.label}
                options={PLACE_OPTIONS.map((o) => ({ id: o.id, label: o.label, text: o.text, hint: placeCounts.get(o.id) }))}
                onChange={(place) => set({ place })}
                allLabel="All"
              />
            )}
            {filtering && (
              <button
                type="button"
                onClick={() => setFilters(NO_FILTERS)}
                className="no-drag ml-1 rounded px-1.5 py-1 text-[12px] text-muted underline-offset-2 hover:text-text hover:underline"
              >
                Clear filters
              </button>
            )}
            <CountLine text={loaded ? count : ''} />
          </>
        }
      >
        <SearchField
          value={filters.query}
          onChange={(query) => set({ query })}
          placeholder="Search prompts…"
          inputRef={searchRef}
          onArrowDown={() => scrollRef.current?.querySelector<HTMLElement>('[role="button"]')?.focus()}
        />
      </MediaToolbar>
      {/* New pictures are marked in the grid; one that couldn't be made has only this place to say so. */}
      <NewPictures view="media" failuresOnly />
      {notice && <NoticeRow onClose={() => setNotice(undefined)}>{notice}</NoticeRow>}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
        {!loaded ? null : stills.length === 0 ? (
          <div className="flex h-full flex-col">
            <EmptyState
              icon={<PictureIcon size={24} />}
              title="No images yet"
              text="Images you create, upload or save from a clip – in sequences, storyboards and Generate – end up here."
            />
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-muted">
            <p>No images match the filters.</p>
            <button
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
              className="text-text underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
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
                title={`Open “${place.name}”`}
                className="rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text"
              >
                {place.kind === 'storyboard' ? 'Go to the storyboard' : 'Go to the sequence'}
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
  return n === 1 ? '1 image' : `${n} images`
}

/**
 * One still in the grid, as a card like a film's: the picture, what it is (the prompt, or what kind of picture) and
 * where it belongs. A new one is marked "New" and counts as seen once it has been on screen a moment; the mark stays
 * while the grid is up, so it can still be found. Not while the viewer covers the grid (`paused`).
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
    <figure className={MEDIA_CARD}>
      <div ref={ref} className="relative">
        <StillThumb still={still} onOpen={onOpen} fill className="aspect-video w-full" />
        {(unseen || wasNew) && (
          <NewChip variant="overlay" title="New image, not looked at yet" className="pointer-events-none absolute left-2 top-2" />
        )}
      </div>
      <figcaption className={MEDIA_CAPTION}>
        <p className="truncate font-medium" title={still.prompt || undefined}>
          {label}
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted">
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
  if (place.kind === 'sequence') return `In the sequence “${place.name}”`
  if (place.kind === 'storyboard') return `In the storyboard “${place.name}”`
  return 'In “Reference images” – belongs to no sequence or storyboard'
}
