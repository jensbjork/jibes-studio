import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FinishedWork, RunningWork, WorkTarget, WorkView } from '@shared/types'
import { pendingApprovals, showApproval, useAgentState } from '../../lib/agent'
import { mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { jumpTo, markAllSeen, markSeen, useNow, useSeenWhenVisible, useWork } from '../../lib/work'
import { ScissorsIcon } from '../editor/icons'
import { ArrowInIcon, CheckIcon, FilmIcon, PictureIcon, WaveIcon } from '../icons'
import { CloseIcon, SparkleIcon } from '../sequences/icons'
import { Spinner, StatusDot } from './StatusMark'
import { finishedMeta, runningMeta, VIEW_LABEL } from './workText'

interface Props {
  open: boolean
  onClose: () => void
  navigate: Navigate
}

/**
 * Activity: everything Studio is working on, grouped by place, and everything that finished that the user
 * hasn't looked at yet, wherever it was started. Floats beside the sidebar, bottom-aligned with its row. A row
 * goes there; nothing here stops or cancels anything (each control lives in one place, its view).
 */
export default function WorkPanel({ open, onClose, navigate }: Props) {
  if (!open) return null
  return <Panel onClose={onClose} navigate={navigate} />
}

function Panel({ onClose, navigate }: Omit<Props, 'open'>) {
  const work = useWork()
  const agent = useAgentState()
  const waiting = pendingApprovals(agent)
  const now = useNow(work.running.length > 0)
  const panel = useRef<HTMLDivElement>(null)

  // Rows that became seen by being on screen here stay listed (without their dot) until the panel closes, so a
  // failure or a picture doesn't vanish while it is being read. Explicit marks (✓, Mark all) remove at once.
  const [seenHere, setSeenHere] = useState<ReadonlyMap<string, FinishedWork>>(new Map())
  const keep = useCallback((w: FinishedWork) => {
    setSeenHere((m) => (m.has(w.key) ? m : new Map(m).set(w.key, w)))
  }, [])

  // Focus moves into the dialog and back to where it came from (the sidebar row) when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => {
      if (before?.isConnected) before.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Escape belongs to a dialog shown over the panel (e.g. an approval), not to the panel.
      if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const go = (target: WorkTarget): void => {
    onClose()
    jumpTo(target, navigate)
  }

  const groups = useMemo(() => groupRunning(work.running), [work.running])

  const { fresh, failed, listed } = useMemo(() => {
    const listed = new Set(work.unseen.map((w) => w.key))
    const all = [...work.unseen, ...[...seenHere.values()].filter((w) => !listed.has(w.key))]
    all.sort((a, b) => b.finishedAt - a.finishedAt)
    return {
      fresh: all.filter((w) => w.status === 'completed'),
      failed: all.filter((w) => w.status === 'failed'),
      listed
    }
  }, [work.unseen, seenHere])

  const isSeen = (w: FinishedWork): boolean => !listed.has(w.key)
  const anyUnseen = work.total.unseen + work.total.failed > 0
  const empty = !work.running.length && !fresh.length && !failed.length

  const markAll = (): void => {
    setSeenHere(new Map())
    void markAllSeen()
  }
  const markOne = (w: FinishedWork): void => {
    setSeenHere((m) => {
      if (!m.has(w.key)) return m
      const next = new Map(m)
      next.delete(w.key)
      return next
    })
    markSeen([w.key])
  }

  return (
    <>
      {/* Clicking anywhere outside closes the panel (the sidebar stays usable: its row toggles it). */}
      <div className="no-drag fixed inset-y-0 left-[var(--sidebar-w)] right-0 z-30" onMouseDown={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-label="Activity"
        tabIndex={-1}
        className="no-drag fixed bottom-3 left-[calc(var(--sidebar-w)+8px)] z-40 flex max-h-[min(70vh,560px)] w-[360px] flex-col rounded-xl border border-line bg-panel shadow-2xl shadow-black/50 outline-none transition-[left] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="font-semibold">Activity</h2>
          {anyUnseen && (
            <button
              onClick={markAll}
              className="ml-auto rounded px-1.5 py-0.5 text-xs text-muted transition hover:bg-raised hover:text-text"
            >
              Mark all as seen
            </button>
          )}
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className={`rounded p-1 text-muted transition hover:bg-raised hover:text-text ${anyUnseen ? '' : 'ml-auto'}`}
          >
            <CloseIcon size={12} />
          </button>
        </div>

        {waiting.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent/5 px-4 py-2.5 text-xs">
            <StatusDot failed large />
            <span className="min-w-0 flex-1 truncate">
              {waiting.length === 1 ? 'A request is waiting for your OK' : `${waiting.length} requests are waiting for your OK`}
            </span>
            <button
              onClick={() => {
                onClose()
                showApproval(waiting[0].id)
              }}
              className="rounded-md bg-accent px-2.5 py-1 font-medium text-white transition hover:bg-accent-hover"
            >
              Review
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {empty ? (
            <p className="px-2 pt-4 text-xs leading-relaxed text-muted">
              Nothing is running right now. What you generate, import, edit or export shows up here while it runs –
              and when it’s done, even if you’re in another view.
            </p>
          ) : (
            <>
              {/* Counted as the sidebar counts (a run with a take at Venice is one), not row by row. */}
              <Section title={`Running · ${work.total.running}`}>
                {groups.length ? (
                  groups.map((g) => (
                    <div key={g.id} className="mb-1">
                      <GroupHeading group={g} onGo={go} />
                      <ul>
                        {g.items.map((w) => (
                          <RunningRow key={w.key} work={w} label={g.shorten(w.label)} now={now} onGo={go} />
                        ))}
                      </ul>
                    </div>
                  ))
                ) : (
                  <Empty>Nothing is running right now.</Empty>
                )}
              </Section>

              <Section title={`Ready to look at · ${work.total.unseen}`}>
                {fresh.length ? (
                  <ul>
                    {fresh.map((w) => (
                      <FinishedRow
                        key={w.key}
                        work={w}
                        seen={isSeen(w)}
                        now={now}
                        onGo={go}
                        onMark={markOne}
                        onSeenHere={keep}
                      />
                    ))}
                  </ul>
                ) : (
                  <Empty>Nothing new to look at.</Empty>
                )}
              </Section>

              {failed.length > 0 && (
                <Section title={`Failed · ${work.total.failed}`}>
                  <ul>
                    {failed.map((w) => (
                      <FinishedRow
                        key={w.key}
                        work={w}
                        seen={isSeen(w)}
                        now={now}
                        onGo={go}
                        onMark={markOne}
                        onSeenHere={keep}
                      />
                    ))}
                  </ul>
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pt-3">
      <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</h3>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1.5 text-xs text-muted">{children}</p>
}

// ── Running work, grouped by place ───────────────────────────────────────────

interface RunGroup {
  id: string
  view?: WorkView
  ownerId?: string
  /** "Sequences · “Beach scene”", "Generate", "Uploads". */
  title: string
  items: RunningWork[]
  /** The row label without the place the heading already names: "Clip 3 in “Beach scene”" → "Clip 3". */
  shorten: (label: string) => string
}

const QUOTED = /“([^”]+)”/g

/**
 * The name of the place an owned item belongs to, read from main's label: an edit's name comes first
 * ("“Interview” – Create music"), everything else names its sequence, storyboard or asset last
 * ("Clip 3 in “Beach scene”", "New voice for “Anna”").
 */
function ownerName(w: RunningWork): string | undefined {
  if (!w.ownerId) return undefined
  const names = [...w.label.matchAll(QUOTED)].map((m) => m[1])
  if (!names.length) return undefined
  return w.view === 'editor' ? names[0] : names[names.length - 1]
}

function shortener(name: string | undefined): (label: string) => string {
  if (!name) return (label) => label
  const tail = ` in “${name}”`
  const head = `“${name}” – `
  return (label) => {
    if (label.endsWith(tail) && label.length > tail.length) return label.slice(0, -tail.length)
    if (label.startsWith(head) && label.length > head.length) return label.slice(head.length)
    return label
  }
}

function groupRunning(running: readonly RunningWork[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  for (const w of running) {
    const id = `${w.view ?? '-'}:${w.ownerId ?? ''}`
    let g = groups.get(id)
    if (!g) {
      g = { id, view: w.view, ownerId: w.ownerId, title: '', items: [], shorten: (label) => label }
      groups.set(id, g)
    }
    g.items.push(w)
  }
  // Named after the place by any of its items that names it (an import is labelled by its file name only).
  for (const g of groups.values()) {
    const name = g.items.map(ownerName).find((n) => n !== undefined)
    g.title = g.view ? `${VIEW_LABEL[g.view]}${name ? ` · “${name}”` : ''}` : 'Uploads'
    g.shorten = shortener(name)
  }
  return [...groups.values()]
}

/** Where a group's heading goes: the place itself, not one item in it. */
function placeTarget(g: RunGroup): WorkTarget | undefined {
  if (!g.view) return undefined
  if (!g.ownerId) return { view: g.view }
  switch (g.view) {
    case 'sequences':
      return { view: g.view, sequenceId: g.ownerId }
    case 'storyboards':
      return { view: g.view, storyboardId: g.ownerId }
    case 'editor':
      return { view: g.view, editId: g.ownerId }
    case 'generate':
      return { view: g.view }
    default:
      return { view: g.view, assetId: g.ownerId }
  }
}

function GroupHeading({ group, onGo }: { group: RunGroup; onGo: (t: WorkTarget) => void }) {
  const target = placeTarget(group)
  const cls = 'block w-full truncate px-2 pb-0.5 pt-1.5 text-left text-xs text-muted'
  if (!target) return <div className={cls}>{group.title}</div>
  return (
    <button onClick={() => onGo(target)} title="Go there" className={`${cls} transition hover:text-text`}>
      {group.title}
    </button>
  )
}

function Thumb({ path, icon }: { path?: string; icon: ReactNode }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="flex h-[27px] w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-raised text-muted">
      {path && !broken ? (
        <img
          src={mediaUrl(path)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        icon
      )}
    </span>
  )
}

function runningIcon(w: RunningWork): ReactNode {
  switch (w.kind) {
    case 'still':
      return <PictureIcon size={14} />
    case 'edit-job':
    case 'render':
      return <ScissorsIcon size={14} />
    case 'voice-design':
    case 'song':
      return <WaveIcon size={14} />
    case 'import':
    case 'upload':
      return <ArrowInIcon size={14} />
    case 'approval':
      return <SparkleIcon size={14} />
    default:
      return <FilmIcon size={14} />
  }
}

function finishedIcon(w: FinishedWork): ReactNode {
  const kind = w.kind === 'failure' ? w.failureOf : w.kind
  switch (kind) {
    case 'still':
      return <PictureIcon size={14} />
    case 'version':
    case 'job':
      return <ScissorsIcon size={14} />
    case 'voice':
      return <WaveIcon size={14} />
    default:
      return <FilmIcon size={14} />
  }
}

const rowButton =
  'flex h-11 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition enabled:hover:bg-raised disabled:cursor-default'

function RunningRow({
  work: w,
  label,
  now,
  onGo
}: {
  work: RunningWork
  label: string
  now: number
  onGo: (t: WorkTarget) => void
}) {
  const meta = runningMeta(w, now)
  return (
    <li>
      <button
        onClick={w.target ? () => onGo(w.target!) : undefined}
        disabled={!w.target}
        title={w.target ? `${w.label} – go there` : w.label}
        className={rowButton}
      >
        <Thumb path={w.thumbPath} icon={runningIcon(w)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-text">{label}</span>
          {meta && <span className="block truncate text-[11px] text-muted">{meta}</span>}
        </span>
        <Spinner />
      </button>
    </li>
  )
}

/** Pictures and failures count as seen once they have been on screen here for a moment; videos only when played. */
function seenByShowing(w: FinishedWork): boolean {
  return w.status === 'failed' || w.kind === 'still'
}

function FinishedRow({
  work: w,
  seen,
  now,
  onGo,
  onMark,
  onSeenHere
}: {
  work: FinishedWork
  seen: boolean
  now: number
  onGo: (t: WorkTarget) => void
  onMark: (w: FinishedWork) => void
  onSeenHere: (w: FinishedWork) => void
}) {
  const ref = useRef<HTMLLIElement>(null)
  useSeenWhenVisible(ref, seenByShowing(w) && !seen ? w.key : undefined, 1500, () => onSeenHere(w))
  const failed = w.status === 'failed'
  const meta = finishedMeta(w, now)

  return (
    <li ref={ref} className="group relative">
      <button onClick={() => onGo(w.target)} title={`${w.label} – go there`} className={`${rowButton} pr-9`}>
        {/* The dot sits on the thumbnail's corner, so the pictures line up with the running rows above. */}
        <span className="relative shrink-0">
          <Thumb path={w.thumbPath} icon={finishedIcon(w)} />
          {!seen && (
            <StatusDot failed={failed} className="absolute -right-1 -top-1 ring-2 ring-[var(--color-panel)]" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[12.5px] ${seen ? 'text-muted' : 'text-text'}`}>{w.label}</span>
          <span
            title={failed && w.error ? w.error : undefined}
            className={`block truncate text-[11px] ${failed && !seen ? 'text-[#ffb3b5]' : 'text-muted'}`}
          >
            {meta}
          </span>
        </span>
      </button>
      {!seen && (
        <button
          onClick={() => onMark(w)}
          title="Mark as seen"
          aria-label={`Mark “${w.label}” as seen`}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted opacity-0 transition hover:bg-line hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
        >
          <CheckIcon size={13} />
        </button>
      )}
    </li>
  )
}
