import { useMemo, useRef, useState } from 'react'
import type { FinishedWork, WorkView } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { markSeen, showWorkStill, useSeenWhenVisible, useUnseen } from '../../lib/work'
import { CloseIcon } from '../sequences/icons'

/** A picture made for nothing (or one that failed) that counts under `view`: no board, clip or sequence shows it. */
function placeless(w: FinishedWork, view: WorkView): boolean {
  if (w.view !== view || w.ownerId) return false
  return w.kind === 'still' || (w.kind === 'failure' && w.failureOf === 'still')
}

/** A picture with no place that couldn't be made. */
function placelessFailure(w: FinishedWork, view: WorkView): boolean {
  return placeless(w, view) && w.kind === 'failure'
}

/**
 * New pictures with no board, clip or sequence to be shown in – an agent's picture made for nothing, say – in the
 * view they count under, so they can be seen there and not only in Pågår och klart. Each counts as seen once it has
 * been on screen a moment (D4) and stays listed until ✕ or the view is left, so it can still be clicked (it opens in
 * the picture viewer). A picture that failed shows its error the same way. `failuresOnly`: just the failures, for a
 * view that shows the new pictures themselves (the Mediabank's Bilder marks them "Ny" in its grid).
 */
export default function NewPictures({ view, failuresOnly = false }: { view: WorkView; failuresOnly?: boolean }) {
  const unseen = useUnseen((w) => (failuresOnly ? placelessFailure(w, view) : placeless(w, view)))
  const [kept, setKept] = useState<FinishedWork[]>([])
  // What ✕ closed; a picture that arrives later shows the row again.
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const visible = useMemo(() => {
    const byKey = new Map<string, FinishedWork>()
    for (const w of [...unseen, ...kept]) if (!closed.has(w.key) && !byKey.has(w.key)) byKey.set(w.key, w)
    return [...byKey.values()].sort((a, b) => b.finishedAt - a.finishedAt)
  }, [unseen, kept, closed])
  if (!visible.length) return null

  const keep = (w: FinishedWork) => setKept((list) => (list.some((x) => x.key === w.key) ? list : [...list, w]))
  const close = () => {
    markSeen(visible.map((w) => w.key))
    setClosed((before) => new Set([...before, ...visible.map((w) => w.key)]))
    setKept([])
  }
  const pictures = visible.filter((w) => w.kind === 'still').length

  return (
    <section
      aria-label="Nya bilder"
      className="flex items-center gap-3 border-b border-line/60 bg-raised/30 px-6 py-2 text-[12px]"
    >
      <span className="shrink-0 text-muted">
        {pictures === visible.length
          ? pictures === 1
            ? 'Ny bild'
            : 'Nya bilder'
          : pictures === 0
            ? visible.length === 1
              ? 'Bild som misslyckades'
              : 'Bilder som misslyckades'
            : 'Nya bilder och fel'}
      </span>
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-0.5">
        {visible.map((w) => (
          <NewPicture key={w.key} work={w} onSeen={() => keep(w)} />
        ))}
      </div>
      <button
        type="button"
        onClick={close}
        title="Stäng – markerar dem som sedda"
        aria-label="Stäng och markera bilderna som sedda"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
      >
        <CloseIcon size={10} />
      </button>
    </section>
  )
}

function NewPicture({ work, onSeen }: { work: FinishedWork; onSeen: () => void }) {
  const ref = useRef<HTMLElement | null>(null)
  const setRef = (el: HTMLElement | null) => {
    ref.current = el
  }
  useSeenWhenVisible(ref, work.key, 1500, onSeen)
  const [broken, setBroken] = useState(false)
  if (work.kind !== 'still') {
    return (
      <span
        ref={setRef}
        title={work.error}
        className="flex h-10 max-w-72 shrink-0 flex-col justify-center rounded bg-accent/10 px-2 leading-tight"
      >
        <span className="truncate text-accent">{work.label}</span>
        <span className="truncate select-text text-[11px] text-[#ffb3b5]">{work.error ?? 'Bilden kunde inte skapas.'}</span>
      </span>
    )
  }
  const stillId = work.stillId
  return (
    <button
      ref={setRef}
      type="button"
      disabled={!stillId}
      onClick={() => stillId && showWorkStill({ stillId, sequenceId: work.target.sequenceId ?? work.target.storyboardId })}
      title={`${work.label} – klicka för att visa den`}
      aria-label={`Visa ${work.label.toLowerCase()}`}
      className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-raised text-[10px] text-muted outline-none transition hover:ring-1 hover:ring-muted focus-visible:ring-2 focus-visible:ring-muted"
    >
      {work.thumbPath && !broken ? (
        <img
          src={mediaUrl(work.thumbPath)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        'Bild'
      )}
    </button>
  )
}
