import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Edit, EditJob, EditProgress, EditVersion } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import Popover from '../pickers/Popover'
import { MoreIcon } from '../sequences/icons'
import { menuRow, onMenuKeyDown, SubView } from '../storyboards/ui'
import { deleteVersionBlocked, formatBytes, formatPrice, jobProgressText, nextVersionNumber, PICTURE_JOB_OPS, priceCheck, priceText, relativeTime, versionName, versionTree, visibleJobs } from './editorUtils'
import { ChevronDownIcon } from './icons'
import SendMenu, { type SentTo } from './SendMenu'
import type { Runner } from './useEditOps'

// Versioner: what is being made (jobs with progress, Avbryt, Fortsätt), and every version as a tree under the
// original. Clicking a version shows it in the player (Jämför); "Använd" makes it the one operations work on.

const DISMISSED_KEY = 'editor:dismissedJobs'
const EXPANDED_KEY = 'editor:versionsOpen'

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) !== '0'
  } catch {
    return true
  }
}

function readDismissed(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

interface Props {
  edit: Edit
  current: EditVersion
  /** The version in the player when it isn't the current one. */
  shownId?: string
  progress: Record<string, EditProgress>
  runner: Runner
  onShow: (versionId: string) => void
  onSetCurrent: (versionId: string) => void
  onSent: (sent: SentTo) => void
  onError: (message: string) => void
  onChanged: () => void
}

export default function VersionsPanel({
  edit,
  current,
  shownId,
  progress,
  runner,
  onShow,
  onSetCurrent,
  onSent,
  onError,
  onChanged
}: Props) {
  const [dismissed, setDismissed] = useState(readDismissed)
  const [expanded, setExpanded] = useState(readExpanded)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const toggleExpanded = () =>
    setExpanded((e) => {
      try {
        localStorage.setItem(EXPANDED_KEY, e ? '0' : '1')
      } catch {
        // Remembering the panel's state is only a convenience.
      }
      return !e
    })
  const rows = versionTree(edit.versions)
  // Running jobs first, in the order their versions will come; then what failed or stopped, newest first.
  const shownJobs = visibleJobs(edit.jobs, dismissed)
  const running = shownJobs.filter((j) => j.status === 'running').sort((a, b) => a.createdAt - b.createdAt)
  const stopped = shownJobs.filter((j) => j.status !== 'running').sort((a, b) => b.createdAt - a.createdAt)
  const next = nextVersionNumber(edit.versions)
  const render = progress.render

  const dismiss = (id: string) =>
    setDismissed((s) => {
      const nextSet = new Set(s).add(id)
      try {
        // Only the newest hundred are remembered; older jobs are long gone from the list anyway.
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...nextSet].slice(-100)))
      } catch {
        // Hiding a job is only a convenience.
      }
      return nextSet
    })

  const busyCount = running.length + (render ? 1 : 0)
  return (
    <section
      aria-label="Versioner"
      className={`flex shrink-0 flex-col border-t border-line ${expanded ? 'max-h-[40%] min-h-36' : ''}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 px-2">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          title={expanded ? 'Fäll ihop versionerna' : 'Visa versionerna'}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 transition hover:bg-raised"
        >
          <ChevronDownIcon size={11} className={`text-muted transition ${expanded ? '' : '-rotate-90'}`} />
          <h2 className="font-medium">Versioner</h2>
          <span className="text-[11px] text-muted">{edit.versions.length}</span>
        </button>
        {!expanded && busyCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {busyCount} pågår
          </span>
        )}
        {expanded && <PruneButton editId={edit.id} count={edit.versions.length} onError={onError} onDone={onChanged} />}
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 ${expanded ? '' : 'hidden'}`}>
        {render && (
          <JobLine
            title={`v${next} ${render.label}`}
            fraction={render.fraction}
            detail={render.fraction === undefined ? 'Skapar version…' : undefined}
          />
        )}
        {[...running, ...stopped].map((job, i) => (
          <JobRow
            key={job.id}
            job={job}
            number={job.status === 'running' ? next + i + (render ? 1 : 0) : undefined}
            progress={progress[job.id]}
            runner={runner}
            onDismiss={() => dismiss(job.id)}
            onError={onError}
            onChanged={onChanged}
          />
        ))}
        <ul>
          {rows.map(({ version, depth }) => (
            <VersionRow
              key={version.id}
              edit={edit}
              version={version}
              depth={depth}
              current={version.id === current.id}
              shown={version.id === shownId}
              now={now}
              onShow={() => onShow(version.id)}
              onSetCurrent={() => onSetCurrent(version.id)}
              onSent={onSent}
              onError={onError}
              onChanged={onChanged}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}

/** A running render or job: its title, a bar and what it is doing. */
function JobLine({
  title,
  fraction,
  detail,
  children
}: {
  title: string
  fraction?: number
  detail?: string
  children?: ReactNode
}) {
  return (
    <div className="mb-1 rounded-md border border-line bg-panel px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
        <span className="min-w-0 flex-1 truncate">{title}…</span>
        {fraction !== undefined && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted">{Math.round(fraction * 100)} %</span>
        )}
        {children}
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-raised">
        <div
          className={`h-full rounded-full bg-accent transition-[width] duration-300 ${fraction === undefined ? 'w-1/3 animate-pulse' : ''}`}
          style={fraction === undefined ? undefined : { width: `${Math.max(3, fraction * 100)}%` }}
        />
      </div>
      {detail && <p className="mt-1 text-[11px] text-muted">{detail}</p>}
    </div>
  )
}

function JobRow({
  job,
  number,
  progress,
  runner,
  onDismiss,
  onError,
  onChanged
}: {
  job: EditJob
  number?: number
  progress?: EditProgress
  runner: Runner
  onDismiss: () => void
  onError: (message: string) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)

  const cancel = async () => {
    setBusy(true)
    try {
      await window.studio.cancelEditJob(job.id)
      onChanged()
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // "Fortsätt" pays again for the parts not sent (or failed): the price on the button is the approval, with the
  // same extra question as any other paid click when it is unknown, leaves a part out (a voice clone) or is above $5.
  // A picture operation whose finish failed only puts its paid take into the film again (free).
  const resume = async () => {
    const ok = await runner.confirmPrice({
      label: `Fortsätt: ${job.label}`,
      priceUsd: job.resumePriceUsd,
      // Main says why a part is left out when every such part is a voice clone; otherwise the generic note is shown.
      priceNote: job.resumePartialPrice ? job.resumePriceNote : undefined,
      check: priceCheck({ paid: true, priceUsd: job.resumePriceUsd, partialPrice: job.resumePartialPrice })
    })
    if (!ok) return
    setBusy(true)
    try {
      // What main compares with is the priced part the button showed (an unknown price was confirmed as unknown), and
      // whether a part was left out of it. Should Venice's price have risen, or a part without a price have come in
      // since (a clone handle that ran out), main refuses and the button shows the new price after the refetch.
      await window.studio.resumeEditJob(
        job.id,
        job.resumePriceUsd ?? 0,
        job.resumePriceUsd === undefined || !!job.resumePartialPrice
      )
      onChanged()
    } catch (e) {
      onError(ipcErrorMessage(e))
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (job.status === 'running') {
    // Main's progress label is "<job> … del 2 av 3": the part after the job's own name is what it is doing now.
    const live = progress?.label?.startsWith(job.label)
      ? progress.label.slice(job.label.length).replace(/^[\s…]+/, '').trim()
      : progress?.label
    const step = live || jobProgressText(job)
    return (
      <JobLine
        title={`${number ? `v${number} ` : ''}${job.label}`}
        fraction={progress?.fraction ?? job.fraction}
        detail={step}
      >
        {job.canCancel && (
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={busy}
            title="Delar som inte har skickats än skickas inte; de som redan skickats blir klara"
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
          >
            Avbryt
          </button>
        )}
      </JobLine>
    )
  }

  const failed = job.status === 'failed'
  const picture = PICTURE_JOB_OPS.has(job.op)
  // Nothing left to send: only the version is made (or, for a picture, the paid take put in again).
  const free = job.resumePriceUsd === 0 && !job.resumePartialPrice
  return (
    <div className={`mb-1 rounded-md border px-2.5 py-2 ${failed ? 'border-accent/30 bg-accent/5' : 'border-line'}`}>
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-accent' : 'bg-muted'}`} />
        <span className="min-w-0 flex-1 truncate">
          {job.label} {failed ? 'misslyckades' : 'avbröts'}
        </span>
        {/* A picture job can be hidden even while it can be finished again: its paid take stays among the edit's takes. */}
        {(!job.canResume || picture) && (
          <button
            type="button"
            onClick={onDismiss}
            title="Dölj"
            className="shrink-0 rounded px-1 text-[11px] text-muted transition hover:bg-raised hover:text-text"
          >
            ✕
          </button>
        )}
      </div>
      {job.error && <p className="mt-1 text-[11px] leading-relaxed text-[#ffb3b5] select-text">{job.error}</p>}
      {job.costUsd > 0 && <p className="mt-0.5 text-[11px] text-muted">Betalt hittills: {formatPrice(job.costUsd)}</p>}
      {job.canResume && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void resume()}
            disabled={busy}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
          >
            {busy
              ? picture
                ? 'Sätter in…'
                : 'Skickar…'
              : `Fortsätt · ${free ? 'gratis' : priceText(job.resumePriceUsd, { partial: job.resumePartialPrice })}`}
          </button>
          <span className="text-[11px] text-muted">
            {picture
              ? 'Sätter in den betalda tagningen igen – inget skickas till Venice.'
              : free
                ? 'Allt är redan hämtat – versionen görs klart.'
                : 'Skickar bara delarna som saknas.'}
          </span>
        </div>
      )}
    </div>
  )
}

function VersionRow({
  edit,
  version,
  depth,
  current,
  shown,
  now,
  onShow,
  onSetCurrent,
  onSent,
  onError,
  onChanged
}: {
  edit: Edit
  version: EditVersion
  depth: number
  current: boolean
  shown: boolean
  /** For "för 2 min sedan": the panel's clock, so every row ticks together. */
  now: number
  onShow: () => void
  onSetCurrent: () => void
  onSent: (sent: SentTo) => void
  onError: (message: string) => void
  onChanged: () => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<'menu' | 'send' | 'delete'>()
  const close = () => setMenu(undefined)
  const blocked = deleteVersionBlocked(version)
  const usedBy = version.usedBy[0]
  // A stopped job that builds on this version and has paid for parts: deleting the version makes them unusable.
  const pausedPaid = edit.jobs.find(
    (j) => j.baseId === version.id && j.canResume && j.costUsd > 0 && !PICTURE_JOB_OPS.has(j.op)
  )

  const remove = async () => {
    close()
    try {
      await window.studio.deleteVersion(version.id)
      onChanged()
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  const reveal = () => {
    close()
    if (version.generation.filePath) void window.studio.revealFile(version.generation.filePath)
  }

  return (
    <li>
      {/* The row's main area is a button of its own; Använd and ⋯ are buttons beside it, not inside it. */}
      <div
        className={`group flex items-center gap-1 rounded-md pr-1 transition ${
          shown ? 'bg-raised' : current ? 'bg-raised/60' : 'hover:bg-raised/50'
        }`}
        style={{ paddingLeft: 8 + Math.min(depth, 6) * 14 }}
      >
        <button
          type="button"
          aria-current={current || undefined}
          onClick={onShow}
          onDoubleClick={() => !current && onSetCurrent()}
          title={current ? 'Den här versionen ändras av åtgärderna' : 'Visa i spelaren (dubbelklicka för att använda den)'}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-muted"
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full border ${current ? 'border-accent bg-accent' : 'border-muted/70'}`}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="shrink-0 tabular-nums text-muted">v{version.number}</span>
              <span className={`truncate ${current ? 'text-text' : ''}`}>
                {version.label || (version.number === 1 ? 'Original' : '')}
              </span>
            </span>
            <span className="block truncate text-[11px] text-muted">
              {version.costUsd ? `${formatPrice(version.costUsd)} · ` : ''}
              {relativeTime(version.createdAt, now)}
              {usedBy && ` · i ”${usedBy.sequenceName}”`}
            </span>
          </span>
        </button>
        {!current && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onSetCurrent()
            }}
            title="Gör den här till versionen som åtgärderna ändrar"
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted opacity-0 transition hover:bg-line hover:text-text focus:opacity-100 group-hover:opacity-100"
          >
            Använd
          </button>
        )}
        <button
          ref={anchor}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setMenu((m) => (m ? undefined : 'menu'))
          }}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          aria-label={`Fler val för ${versionName(version)}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-line hover:text-text focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
        >
          <MoreIcon size={12} />
        </button>
      </div>
      <Popover anchorRef={anchor} open={!!menu} onClose={close} align="end" width={300} label={versionName(version)}>
        {menu === 'send' ? (
          <SubView title={`Skicka ${versionName(version)}`} onBack={() => setMenu('menu')}>
            <SendMenu
              versionId={version.id}
              origin={edit.origin}
              onSent={(sent) => {
                close()
                onSent(sent)
              }}
              onError={(message) => {
                close()
                onError(message)
              }}
            />
          </SubView>
        ) : menu === 'delete' ? (
          <div className="p-3">
            <p className="mb-1">Radera {versionName(version)}?</p>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">
              Filen flyttas till papperskorgen. Versioner gjorda från den flyttas upp ett steg i trädet.
              {pausedPaid && (
                <span className="mt-1.5 block text-[#ffb3b5]">
                  Jobbet ”{pausedPaid.label}” utgår från den och har redan betalat {formatPrice(pausedPaid.costUsd)}. Det
                  kan inte fortsättas när versionen är borta.
                </span>
              )}
            </p>
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setMenu('menu')}
                className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                Avbryt
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => void remove()}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover"
              >
                Radera
              </button>
            </div>
          </div>
        ) : (
          <div role="menu" aria-label={versionName(version)} onKeyDown={onMenuKeyDown} className="p-1">
            <button
              type="button"
              role="menuitem"
              data-menu-item
              autoFocus
              disabled={current}
              onClick={() => {
                close()
                onSetCurrent()
              }}
              className={menuRow}
            >
              Använd den här versionen
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              disabled={!version.generation.filePath || version.generation.fileMissing}
              title={version.generation.fileMissing ? 'Filmfilen saknas (flyttad eller raderad i Finder)' : undefined}
              onClick={reveal}
              className={menuRow}
            >
              Visa i Finder
            </button>
            <button type="button" role="menuitem" data-menu-item onClick={() => setMenu('send')} className={menuRow}>
              Skicka till…
            </button>
            <div className="mx-2 my-1 border-t border-line" />
            <button
              type="button"
              role="menuitem"
              data-menu-item
              disabled={!!blocked}
              onClick={() => setMenu('delete')}
              title={blocked}
              className={`${menuRow} flex-col items-start gap-0.5 text-muted hover:text-accent`}
            >
              <span>Radera versionen…</span>
              {blocked && <span className="text-[11px] leading-snug">{blocked}</span>}
            </button>
          </div>
        )}
      </Popover>
    </li>
  )
}

/** "Rensa versioner…": counts what would go first ("6 versioner · 1,2 GB"), then moves it to the Trash. */
export function usePrune(editId: string, onError: (message: string) => void, onDone: () => void) {
  const [found, setFound] = useState<{ count: number; bytes: number }>()
  const [busy, setBusy] = useState(false)

  const check = async (): Promise<boolean> => {
    setBusy(true)
    try {
      setFound(await window.studio.pruneVersions(editId, true))
      return true
    } catch (e) {
      onError(ipcErrorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const prune = async () => {
    setBusy(true)
    try {
      await window.studio.pruneVersions(editId, false)
      setFound(undefined)
      onDone()
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return { found, busy, check, prune, reset: () => setFound(undefined) }
}

/** What Rensa versioner would move to the Trash, with Avbryt and Rensa. */
export function PruneConfirm({
  found,
  busy,
  onCancel,
  onPrune
}: {
  found: { count: number; bytes: number }
  busy: boolean
  onCancel: () => void
  onPrune: () => void
}) {
  if (found.count === 0) {
    return (
      <div className="p-3">
        <p className="mb-3 text-[12px] leading-relaxed text-muted">
          Inget att rensa: alla versioner är originalet, den aktuella, versioner den bygger på eller används i en
          sekvens eller av en annan redigering.
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] transition hover:bg-raised"
          >
            OK
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="p-3">
      <p className="mb-1">
        {found.count} {found.count === 1 ? 'version' : 'versioner'} · {formatBytes(found.bytes)}
      </p>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        Flyttas till papperskorgen. Originalet, den aktuella versionen, versionerna den bygger på och de som används i
        sekvenser eller av andra redigeringar behålls.
      </p>
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
        >
          Avbryt
        </button>
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onPrune}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
        >
          {busy ? 'Rensar…' : 'Rensa'}
        </button>
      </div>
    </div>
  )
}

function PruneButton({
  editId,
  count,
  onError,
  onDone
}: {
  editId: string
  count: number
  onError: (message: string) => void
  onDone: () => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const prune = usePrune(editId, onError, onDone)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => void prune.check()}
        disabled={prune.busy || count < 2}
        title="Flytta versioner som inte behövs till papperskorgen"
        className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Rensa versioner…
      </button>
      <Popover anchorRef={anchor} open={!!prune.found} onClose={prune.reset} align="end" width={300} label="Rensa versioner">
        {prune.found && (
          <PruneConfirm found={prune.found} busy={prune.busy} onCancel={prune.reset} onPrune={() => void prune.prune()} />
        )}
      </Popover>
    </>
  )
}
