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
import { inGenerateSession } from '@shared/session'
import type { Generation, VideoModel } from '@shared/types'
import { useAssetsState } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { useFreshGenerationIds } from '../../lib/work'
import GenerationCard from '../GenerationCard'
import { CloseIcon } from '../sequences/icons'
import { Spinner } from '../work/StatusMark'
import ClipDrawer from './ClipDrawer'
import ClipTable from './ClipTable'
import {
  effectiveFilters,
  filterChips,
  hasFilters,
  loadSessionFilters,
  loadSort,
  loadView,
  NO_FILTERS,
  saveSessionFilters,
  saveSort,
  saveView,
  toGenerationFilter,
  withoutFilter,
  type FeedFilters,
  type FeedMode,
  type FeedView,
  type SortKey
} from './feedFilter'
import { isPending, summaryText } from './feedText'
import FeedToolbar, { MediaLink, SessionToolbar } from './FeedToolbar'
import { ImportIcon } from './icons'
import { carriesFiles, DropHint, droppedVideoPaths, ImportCardView, useImportCards, useImportFlow } from './ownClips'
import { buildLibraryIndex } from './references'
import type { GenerationsState } from './useGenerations'
import { useSession } from './useSession'

interface Props {
  feed: GenerationsState
  models: readonly VideoModel[]
  navigate: Navigate
  /**
   * library (Media's Videos): every clip, with search, filters and order. session (Generate): only what was
   * made in Generate this session (shared/session.ts), newest first, under a short header.
   */
  mode?: FeedMode
  /** "Use again": fill the Generate form with the clip's settings. */
  onReuse: (g: Generation) => void
  /** The drawer's tooltip for "Use again", when it also leaves for Generate. */
  reuseTitle?: string
  /** Shown while the list has nothing at all (in session mode: nothing made this session). */
  emptyText: ReactNode
  /** Left end of the toolbar's first row (Media's tabs). */
  leading?: ReactNode
  /** Right end of the toolbar's first row (e.g. the folder button). */
  trailing?: ReactNode
  /**
   * Open this clip in the drawer (Activity, an agent's open_in_studio); `source: 'agent'` marks nothing seen.
   * In session mode a clip from outside the session is shown in Media instead.
   */
  openRequest?: { generationId: string; source?: 'agent' }
  /** The request was carried out (or the clip no longer exists, or it went on to Media). */
  onOpenRequestHandled?: () => void
}

/** Cards rendered at first; more are added as the list scrolls towards its end. */
const CARD_PAGE = 60

/**
 * The clip feed: every generation as large cards or as a table, with search, filters, sorting, a summary of
 * what is shown and a detail drawer for one clip. Filtering follows the shared rules the agents'
 * list_generations tool uses, so "the 4-star clips with Anna" means the same thing to both. In session mode
 * (Generate) it lists only this session's clips, newest first, with no search, filters or order to choose.
 */
export default function ClipFeed({
  feed,
  models,
  navigate,
  mode = 'library',
  onReuse,
  reuseTitle,
  emptyText,
  leading,
  trailing,
  openRequest,
  onOpenRequestHandled
}: Props) {
  const { generations, loaded: feedLoaded, rate, remove, patch } = feed
  const { assets, loaded: assetsLoaded } = useAssetsState()
  const index = useMemo(() => buildLibraryIndex(assets), [assets])

  // Session mode: the clips made in Generate since Studio started (and any on their way from before).
  const session = mode === 'session'
  const current = useSession()
  const loaded = feedLoaded && (!session || current !== undefined)
  const pool = useMemo(
    () =>
      !session ? generations : current === undefined ? [] : generations.filter((g) => inGenerateSession(g, current)),
    [session, generations, current]
  )

  const [view, setViewState] = useState<FeedView>(() => loadView(mode))
  const [sortChoice, setSortState] = useState<SortKey>(loadSort)
  const [filterChoice, setFiltersState] = useState<FeedFilters>(loadSessionFilters)
  // The session list neither filters nor sorts; Media's choices stay as they were.
  const sort: SortKey = session ? 'newest' : sortChoice
  const filters = session ? NO_FILTERS : filterChoice
  const [selectedId, setSelectedId] = useState<string>()
  const [openId, setOpenId] = useState<string>()
  // Who opened the drawer: an agent's request shows the clip without counting as the user looking at it.
  const [openSource, setOpenSource] = useState<'agent'>()
  const [cardLimit, setCardLimit] = useState(CARD_PAGE)

  // Own films brought into the feed ("Import own clips…", or dropped on it).
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
    saveView(v, mode)
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

  // Activity: the finished clips the user hasn't looked at yet ("New") – every one, also past the 200 that
  // the panel lists in full.
  const unseenIds = useFreshGenerationIds()
  // While "New" is on, a clip stays listed after it was watched (it would otherwise vanish a second into playing
  // it); the list forgets them when the filter goes off. The rule is the shared filter's (unseen), applied here so
  // the cards keep their identity.
  const keptNew = useRef<Set<string>>(new Set())
  const newIds = useMemo(() => {
    if (!active.unseen) {
      keptNew.current = new Set()
      return undefined
    }
    for (const id of unseenIds) keptNew.current.add(id)
    return new Set(keptNew.current)
  }, [active.unseen, unseenIds])

  const shown = useMemo(() => {
    const listed = newIds ? pool.filter((g) => newIds.has(g.id)) : pool
    return queryGenerations(listed, toGenerationFilter({ ...active, unseen: undefined }, sort, Date.now()), index.paths)
  }, [pool, newIds, active, sort, index])
  const pendingCount = useMemo(() => generations.filter(isPending).length, [generations])
  const unseenCount = useMemo(() => generations.filter((g) => unseenIds.has(g.id)).length, [generations, unseenIds])
  const filtering = hasFilters(active)

  const summary = useMemo(() => {
    const text = summaryText(summarizeGenerations(shown))
    if (session) return `This session · ${text}`
    return filtering ? text.replace(/^(\d+) clips?/, `$1 of ${generations.length} clips`) : text
  }, [shown, session, filtering, generations.length])

  // A generation that starts while filters hide it would look like nothing happened.
  const hiddenPending = useMemo(() => {
    if (!filtering) return 0
    const visible = new Set(shown.map((g) => g.id))
    return generations.filter((g) => isPending(g) && !visible.has(g.id)).length
  }, [filtering, generations, shown])

  const showAll = useCallback(() => navigate('media', { type: 'open-media', tab: 'videos' }), [navigate])

  // New filters or order: the cards start from the top (the table keeps its selected row in view itself).
  const filterKey = JSON.stringify([active, sort])
  useEffect(() => {
    setCardLimit(CARD_PAGE)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [filterKey])

  // ⌘F searches the clips (the session list has no search).
  useEffect(() => {
    if (session) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.defaultPrevented && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])

  // ── The drawer ───────────────────────────────────────────────────────────────

  const openGeneration = openId ? generations.find((g) => g.id === openId) : undefined
  const openIndex = openId ? shown.findIndex((g) => g.id === openId) : -1
  // Where the open clip was in the list, for stepping on after it drops out (e.g. rated while filtering on
  // unrated clips).
  const lastOpenIndex = useRef(0)
  if (openIndex >= 0) lastOpenIndex.current = openIndex

  // Deleted elsewhere (or by its own Delete): close.
  useEffect(() => {
    if (openId && loaded && !openGeneration) setOpenId(undefined)
  }, [openId, loaded, openGeneration])

  const open = useCallback((id: string) => {
    setSelectedId(id)
    setOpenId(id)
    setOpenSource(undefined)
  }, [])

  // "Go there" from Activity, or an agent showing the user a clip: open it in the drawer. A filter that hides
  // it is lifted, with a note, rather than opening a clip the list doesn't show. The session list sends a clip from
  // outside the session on to Media, which lists every clip (still on the agent's behalf if it asked).
  const handledRequest = useRef<typeof openRequest>(undefined)
  useEffect(() => {
    if (!openRequest || !loaded || handledRequest.current === openRequest) return
    handledRequest.current = openRequest
    const g = generations.find((x) => x.id === openRequest.generationId)
    if (!g) {
      setImportNotice({ text: 'The clip is no longer in the library.', error: false })
    } else if (session && !pool.some((x) => x.id === g.id)) {
      // Handled first: App keeps the intent the navigation sets, not the cleared one.
      onOpenRequestHandled?.()
      navigate('media', {
        type: 'open-media',
        tab: 'videos',
        generationId: g.id,
        ...(openRequest.source ? { source: openRequest.source } : {})
      })
      return
    } else {
      if (!shown.some((x) => x.id === g.id) && hasFilters(filters)) {
        setFilters({ query: '' })
        setImportNotice({ text: 'The filters hid the clip, so they were cleared.', error: false })
      }
      open(g.id)
      if (openRequest.source === 'agent') setOpenSource('agent')
    }
    onOpenRequestHandled?.()
  }, [openRequest, loaded])
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

  const importLabel = importFlow.inspecting ? 'Reading the files…' : 'Import own clips…'
  const toolbarTrailing = (
    <>
      <button
        type="button"
        onClick={() => void pickFiles()}
        disabled={importFlow.inspecting}
        title="Add your own films (or drag them in here)"
        aria-label={session ? importLabel : undefined}
        className="no-drag flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
      >
        <ImportIcon size={13} />
        {/* Beside Generate's form the list is narrow: the label shows once the work area has room for it. */}
        <span className={session ? 'hidden @min-[67rem]/main:inline' : undefined}>{importLabel}</span>
      </button>
      {trailing}
    </>
  )

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      {session ? (
        <SessionToolbar
          view={view}
          onView={setView}
          summary={loaded ? summary : ''}
          onShowAll={showAll}
          trailing={toolbarTrailing}
        />
      ) : (
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
          pendingCount={pendingCount}
          unseenCount={unseenCount}
          onSearchArrowDown={() => {
            if (view === 'table') {
              tableRef.current?.focus()
              if (!selectedId && shown[0]) setSelectedId(shown[0].id)
            } else {
              scrollRef.current?.querySelector<HTMLElement>('[data-card-open]')?.focus()
            }
          }}
          leading={leading}
          trailing={toolbarTrailing}
        />
      )}

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
            title="Close"
          >
            ✕
          </button>
        </div>
      )}

      {feed.error && (
        <div className="flex items-start gap-2 border-b border-line/60 bg-accent/10 px-6 py-2 text-[12px] text-accent">
          <span className="min-w-0 flex-1 select-text">{feed.error}</span>
          <button type="button" onClick={feed.clearError} className="shrink-0 hover:text-text" title="Close">
            ✕
          </button>
        </div>
      )}
      {hiddenPending > 0 && (
        <div className="flex items-center gap-2 border-b border-line/60 bg-raised/50 px-6 py-1.5 text-[12px] text-muted">
          <Spinner />
          <span className="min-w-0 flex-1">
            {hiddenPending === 1 ? 'A clip is generating' : `${hiddenPending} clips are generating`} but hidden by the filters.
          </span>
          <button
            type="button"
            onClick={() => setFilters({ query: '' })}
            className="shrink-0 text-text underline-offset-2 hover:underline"
          >
            Clear filters
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
        {dropping && <DropHint text="Drop to import as own clips" />}
        {!loaded ? null : pool.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <p className="max-w-md leading-relaxed text-balance">{emptyText}</p>
            {session && <MediaLink onClick={showAll} className="mb-2" />}
            <span className="text-[12px]">Have your own films? Drag them in here or choose Import own clips.</span>
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-muted">
            <p>No clips match the filters.</p>
            <div className="flex max-w-md flex-wrap justify-center gap-1.5">
              {filterChips(filters, models, assets).map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setFilters(withoutFilter(filters, c.key))}
                  title="Remove the filter"
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
              Clear filters
            </button>
          </div>
        ) : view === 'table' ? (
          <ClipTable
            generations={shown}
            models={models}
            index={index}
            sort={sort}
            onSort={session ? undefined : setSort}
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
            reuseTitle={reuseTitle}
            onDelete={(g) => void removeGeneration(g)}
            onChange={patch}
            onRate={rate}
            navigate={navigate}
            openedByAgent={openSource === 'agent'}
          />
        )}
      </div>
    </div>
  )
}
