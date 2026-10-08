import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from 'react'
import { queryGenerations, summarizeGenerations } from '@shared/generation-filter'
import type { Generation, VideoModel } from '@shared/types'
import { useAssetsState } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import GenerationCard from '../GenerationCard'
import { CloseIcon } from '../sequences/icons'
import ClipDrawer from './ClipDrawer'
import ClipTable from './ClipTable'
import {
  effectiveFilters,
  filterChips,
  hasFilters,
  loadSessionFilters,
  loadSort,
  loadView,
  saveSessionFilters,
  saveSort,
  saveView,
  toGenerationFilter,
  withoutFilter,
  type FeedFilters,
  type FeedView,
  type SortKey
} from './feedFilter'
import { isPending, summaryText } from './feedText'
import FeedToolbar from './FeedToolbar'
import { ImportIcon } from './icons'
import { carriesFiles, DropHint, droppedVideoPaths, ImportCardView, useImportCards, useImportFlow } from './ownClips'
import { buildLibraryIndex } from './references'
import type { GenerationsState } from './useGenerations'

interface Props {
  feed: GenerationsState
  models: readonly VideoModel[]
  navigate: Navigate
  /** "Använd igen": fill the Generate form with the clip's settings. */
  onReuse: (g: Generation) => void
  /** Shown while there are no generations at all. */
  emptyText: ReactNode
  /** Right end of the toolbar's first row (e.g. the folder button). */
  trailing?: ReactNode
}

/** Cards rendered at first; more are added as the list scrolls towards its end. */
const CARD_PAGE = 60

/**
 * The clip feed: every generation as large cards or as a table, with search, filters, sorting, a summary of
 * what is shown and a detail drawer for one clip. Filtering follows the shared rules the agents'
 * list_generations tool uses, so "the 4-star clips with Anna" means the same thing to both.
 */
export default function ClipFeed({ feed, models, navigate, onReuse, emptyText, trailing }: Props) {
  const { generations, loaded, rate, remove, patch } = feed
  const { assets, loaded: assetsLoaded } = useAssetsState()
  const index = useMemo(() => buildLibraryIndex(assets), [assets])

  const [view, setViewState] = useState<FeedView>(loadView)
  const [sort, setSortState] = useState<SortKey>(loadSort)
  const [filters, setFiltersState] = useState<FeedFilters>(loadSessionFilters)
  const [selectedId, setSelectedId] = useState<string>()
  const [openId, setOpenId] = useState<string>()
  const [cardLimit, setCardLimit] = useState(CARD_PAGE)

  // Own films brought into the feed ("Importera egna klipp…", or dropped on it).
  const importFlow = useImportFlow()
  const importing = useImportCards().filter((c) => c.target === 'feed')
  const [dropping, setDropping] = useState(false)
  const [importNotice, setImportNotice] = useState<{ text: string; error: boolean }>()

  const importFiles = async (paths: string[]) => {
    if (!paths.length) return
    setImportNotice(undefined)
    const outcome = await importFlow.begin(paths, { kind: 'feed' })
    if (outcome.errors.length) setImportNotice({ text: outcome.errors.join('\n'), error: true })
    else if (outcome.notes.length) setImportNotice({ text: outcome.notes.join('\n'), error: false })
  }
  const pickFiles = async () => {
    try {
      await importFiles(await window.studio.pickVideos(true))
    } catch (e) {
      setImportNotice({ text: e instanceof Error ? e.message : String(e), error: true })
    }
  }
  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    setDropping(false)
    void importFiles(droppedVideoPaths(e).paths)
  }

  const searchRef = useRef<HTMLInputElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const setView = (v: FeedView) => {
    setViewState(v)
    saveView(v)
  }
  const setSort = (s: SortKey) => {
    setSortState(s)
    saveSort(s)
  }
  const setFilters = (f: FeedFilters) => {
    setFiltersState(f)
    saveSessionFilters(f)
  }

  // Typing in the search field stays responsive with thousands of clips: the list catches up a moment later.
  const deferredFilters = useDeferredValue(filters)
  const active = effectiveFilters(deferredFilters, assets, assetsLoaded)
  const shown = useMemo(
    () => queryGenerations(generations, toGenerationFilter(active, sort, Date.now()), index.paths),
    [generations, active, sort, index]
  )
  const filtering = hasFilters(active)

  const summary = useMemo(() => {
    const text = summaryText(summarizeGenerations(shown))
    return filtering ? text.replace(/^(\d+) klipp/, `$1 av ${generations.length} klipp`) : text
  }, [shown, filtering, generations.length])

  // A generation that starts while filters hide it would look like nothing happened.
  const hiddenPending = useMemo(() => {
    if (!filtering) return 0
    const visible = new Set(shown.map((g) => g.id))
    return generations.filter((g) => isPending(g) && !visible.has(g.id)).length
  }, [filtering, generations, shown])

  // New filters or order: the cards start from the top (the table keeps its selected row in view itself).
  const filterKey = JSON.stringify([active, sort])
  useEffect(() => {
    setCardLimit(CARD_PAGE)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [filterKey])

  // ⌘F searches the clips.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── The drawer ───────────────────────────────────────────────────────────────

  const openGeneration = openId ? generations.find((g) => g.id === openId) : undefined
  const openIndex = openId ? shown.findIndex((g) => g.id === openId) : -1
  // Where the open clip was in the list, for stepping on after it drops out (e.g. rated while filtering on
  // unrated clips).
  const lastOpenIndex = useRef(0)
  if (openIndex >= 0) lastOpenIndex.current = openIndex

  // Deleted elsewhere (or by its own Radera): close.
  useEffect(() => {
    if (openId && loaded && !openGeneration) setOpenId(undefined)
  }, [openId, loaded, openGeneration])

  const open = useCallback((id: string) => {
    setSelectedId(id)
    setOpenId(id)
  }, [])
  const close = useCallback(() => setOpenId(undefined), [])

  const step = (delta: 1 | -1): (() => void) | undefined => {
    const from = openIndex >= 0 ? openIndex : delta === 1 ? lastOpenIndex.current - 1 : lastOpenIndex.current
    const target = shown[from + delta]
    return target ? () => open(target.id) : undefined
  }

  // Read through refs so the callbacks handed to every card stay the same while the list changes (the cards
  // are memoized; a new callback would re-render all of them on each job update).
  const shownRef = useRef(shown)
  shownRef.current = shown
  const openIdRef = useRef(openId)
  openIdRef.current = openId

  const removeGeneration = useCallback(
    async (g: Generation) => {
      // The drawer moves on to the neighbour rather than closing, so a run of bad takes is quick to clear out.
      const list = shownRef.current
      const i = list.findIndex((x) => x.id === g.id)
      const neighbour = i >= 0 ? (list[i + 1] ?? list[i - 1]) : undefined
      if (!(await remove(g))) return
      if (openIdRef.current === g.id) {
        if (neighbour) open(neighbour.id)
        else setOpenId(undefined)
      }
    },
    [remove, open]
  )
  const openCard = useCallback((g: Generation) => open(g.id), [open])

  // ── Cards: render more as the end comes into view, and show the open card ────

  useEffect(() => {
    if (view !== 'cards') return
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCardLimit((n) => n + CARD_PAGE)
      },
      { root, rootMargin: '1200px 0px' }
    )
    // A new observer per page: it reports right away whether the sentinel is (still) near, which a long-lived
    // one would not after the page grew without the sentinel ever leaving the margin.
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [view, cardLimit, shown.length])

  // Opening a clip (or switching to cards with one open) brings its card into view. A card past the rendered
  // page has to wait for the page to grow, so the scroll stays pending until the card is in the DOM; growing the
  // page by scrolling must not pull the view back to the open card, hence the flag rather than cardLimit alone.
  const revealOpen = useRef(false)
  useEffect(() => {
    revealOpen.current = view === 'cards' && openIndex >= 0
    if (revealOpen.current && openIndex >= cardLimit) setCardLimit(openIndex + CARD_PAGE)
  }, [openId, view, openIndex >= 0])
  useEffect(() => {
    if (!revealOpen.current || view !== 'cards' || !openId) return
    const card = scrollRef.current?.querySelector(`[data-generation-id="${CSS.escape(openId)}"]`)
    if (!card) return
    revealOpen.current = false
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [openId, view, openIndex >= 0, cardLimit])

  const modelOf = (id: string) => models.find((m) => m.id === id)

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      <FeedToolbar
        view={view}
        onView={setView}
        filters={filters}
        onFilters={setFilters}
        sort={sort}
        onSort={setSort}
        summary={loaded ? summary : ''}
        generations={generations}
        models={models}
        assets={assets}
        index={index}
        searchRef={searchRef}
        onSearchArrowDown={() => {
          if (view === 'table') {
            tableRef.current?.focus()
            if (!selectedId && shown[0]) setSelectedId(shown[0].id)
          } else {
            scrollRef.current?.querySelector<HTMLElement>('[data-card-open]')?.focus()
          }
        }}
        trailing={
          <>
            <button
              type="button"
              onClick={() => void pickFiles()}
              disabled={importFlow.inspecting}
              title="Lägg till dina egna filmer i klippflödet (eller dra in dem hit)"
              className="no-drag flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
            >
              <ImportIcon size={13} />
              {importFlow.inspecting ? 'Läser filerna…' : 'Importera egna klipp…'}
            </button>
            {trailing}
          </>
        }
      />

      {importNotice && (
        <div
          className={`flex items-start gap-2 border-b border-line/60 px-6 py-2 text-[12px] ${
            importNotice.error ? 'bg-accent/10 text-accent' : 'bg-raised/50 text-text'
          }`}
        >
          <span className="min-w-0 flex-1 whitespace-pre-line select-text">{importNotice.text}</span>
          <button
            type="button"
            onClick={() => setImportNotice(undefined)}
            className="shrink-0 hover:text-text"
            title="Stäng"
          >
            ✕
          </button>
        </div>
      )}

      {feed.error && (
        <div className="flex items-start gap-2 border-b border-line/60 bg-accent/10 px-6 py-2 text-[12px] text-accent">
          <span className="min-w-0 flex-1 select-text">{feed.error}</span>
          <button type="button" onClick={feed.clearError} className="shrink-0 hover:text-text" title="Stäng">
            ✕
          </button>
        </div>
      )}
      {hiddenPending > 0 && (
        <div className="flex items-center gap-2 border-b border-line/60 bg-raised/50 px-6 py-1.5 text-[12px] text-muted">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
          <span className="min-w-0 flex-1">
            {hiddenPending === 1 ? 'Ett klipp genereras' : `${hiddenPending} klipp genereras`} men döljs av filtren.
          </span>
          <button
            type="button"
            onClick={() => setFilters({ query: '' })}
            className="shrink-0 text-text underline-offset-2 hover:underline"
          >
            Rensa filter
          </button>
        </div>
      )}

      {importing.length > 0 && (
        <div className="flex shrink-0 gap-3 overflow-x-auto border-b border-line/60 px-6 py-3">
          {importing.map((card) => (
            <div key={card.path} className="h-24 w-72 shrink-0 overflow-hidden rounded-lg border border-line bg-panel">
              <ImportCardView card={card} compact />
            </div>
          ))}
        </div>
      )}

      <div
        className="relative min-h-0 flex-1"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        }}
      >
        {dropping && <DropHint text="Släpp för att importera som egna klipp" />}
        {!loaded ? null : generations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            {emptyText}
            <span className="text-[12px]">Har du egna filmer? Dra in dem hit eller välj Importera egna klipp.</span>
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-muted">
            <p>Inga klipp matchar filtren.</p>
            <div className="flex max-w-md flex-wrap justify-center gap-1.5">
              {filterChips(filters, models, assets).map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setFilters(withoutFilter(filters, c.key))}
                  title="Ta bort filtret"
                  className="flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent/10 py-0.5 pl-2.5 pr-2 text-[12px] text-text transition hover:bg-accent/20"
                >
                  {c.label}
                  <CloseIcon size={8} className="text-muted" />
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setFilters({ query: '' })}
              className="text-text underline-offset-2 hover:underline"
            >
              Rensa filter
            </button>
          </div>
        ) : view === 'table' ? (
          <ClipTable
            generations={shown}
            models={models}
            index={index}
            sort={sort}
            onSort={setSort}
            selectedId={selectedId}
            onSelect={setSelectedId}
            openId={openId}
            onOpen={open}
            onClose={close}
            onRate={rate}
            bodyRef={tableRef}
            resetKey={filterKey}
          />
        ) : (
          <div ref={scrollRef} className="h-full overflow-y-auto px-6 pb-6 pt-4">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
              {shown.slice(0, cardLimit).map((g) => (
                <GenerationCard
                  key={g.id}
                  generation={g}
                  model={modelOf(g.model)}
                  onReuse={onReuse}
                  onDelete={removeGeneration}
                  navigate={navigate}
                  onChange={patch}
                  onOpen={openCard}
                  onRate={rate}
                  selected={g.id === openId}
                />
              ))}
            </div>
            {shown.length > cardLimit && <div ref={sentinelRef} className="h-px" />}
          </div>
        )}
        {importFlow.dialog}

        {openGeneration && (
          <ClipDrawer
            generation={openGeneration}
            models={models}
            index={index}
            position={openIndex >= 0 ? { index: openIndex, total: shown.length } : undefined}
            onPrev={step(-1)}
            onNext={step(1)}
            onClose={close}
            onReuse={onReuse}
            onDelete={(g) => void removeGeneration(g)}
            onChange={patch}
            onRate={rate}
            navigate={navigate}
          />
        )}
      </div>
    </div>
  )
}
