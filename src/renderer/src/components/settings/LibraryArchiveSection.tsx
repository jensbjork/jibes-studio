import { useSyncExternalStore } from 'react'
import type { ArchiveProgress, ArchiveResult } from '@shared/types'
import { freezeGenerateParams } from '../../lib/generateStore'
import { ipcErrorMessage } from '../../lib/hooks'
import { readRememberedParams, rememberAfterSwitch } from '../../lib/library'
import SwitchingOverlay from '../library/SwitchingOverlay'

// Settings → Export & import: the whole library to one zip file, and such a zip opened as the library (main's
// library-archive.ts does the work). What runs is kept here, outside the component, so it is still shown after the
// user has been elsewhere in the app while a long export ran.

type Kind = ArchiveProgress['kind']

interface ArchiveState {
  /** A call in flight: its dialog is open (no progress yet) or main is working (progress). */
  running?: { kind: Kind; progress?: ArchiveProgress; cancelling?: boolean }
  /** The last export that finished, with main's note on files left out, if any. */
  exported?: { result: ArchiveResult; note?: string }
  /** The last export or import that was called off. */
  cancelled?: Kind
  error?: string
  /** An import opened its library: the window reloads onto it in a moment. */
  reloading?: boolean
}

let state: ArchiveState = {}
const listeners = new Set<() => void>()
/** What main said when the job in flight ended ('done' may carry a note). */
let ended: ArchiveProgress | undefined
/** A call of ours is waiting for main's answer (otherwise progress comes from one started before a reload). */
let pending = false
let subscribed = false

/** Read through a function: TypeScript can't see onProgress set it while a call was awaited. */
function endOfJob(): ArchiveProgress | undefined {
  return ended
}

function snapshot(): ArchiveState {
  return state
}

function setState(next: ArchiveState): void {
  state = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscribed) {
    subscribed = true
    window.studio.onArchiveProgress(onProgress)
  }
  return () => listeners.delete(listener)
}

function onProgress(p: ArchiveProgress): void {
  const terminal = p.phase === 'done' || p.phase === 'failed' || p.phase === 'cancelled'
  if (!terminal) {
    setState({ ...state, running: { kind: p.kind, progress: p, cancelling: state.running?.cancelling } })
    return
  }
  ended = p
  // The call's own answer settles it; this only covers a job this window didn't start (a reload in between).
  if (pending) return
  setState({
    running: undefined,
    error: p.phase === 'failed' ? p.message : undefined,
    cancelled: p.phase === 'cancelled' ? p.kind : undefined
  })
}

async function start(kind: Kind): Promise<void> {
  if (pending || state.running || state.reloading) return
  pending = true
  ended = undefined
  // The last export's line stays (hidden while this runs) in case the dialog is closed without choosing anything.
  const previous = state.exported
  setState({ running: { kind }, exported: previous })
  try {
    if (kind === 'export') {
      const result = await window.studio.exportLibraryArchive()
      const end = endOfJob()
      const note = end?.phase === 'done' ? end.message : undefined
      const cancelled = !result && end?.phase === 'cancelled'
      setState({
        exported: result ? { result, note } : cancelled ? undefined : previous,
        cancelled: cancelled ? kind : undefined
      })
      return
    }
    // The library open now, so what the generate form remembers from it is let go once the imported one opens.
    const before = await window.studio.libraryStatus().catch(() => undefined)
    const result = await window.studio.importLibraryArchive()
    if (!result) {
      const cancelled = endOfJob()?.phase === 'cancelled'
      setState({ exported: cancelled ? undefined : previous, cancelled: cancelled ? kind : undefined })
      return
    }
    // Main has opened the imported library and reloads the window in a moment; as after switching libraries
    // (useLibrarySwitch), nothing of the old library's form may be saved over what is remembered for the new one.
    freezeGenerateParams()
    rememberAfterSwitch(
      { mode: 'open', oldRoot: before?.root, oldIsLegacy: false, newRoot: result.path },
      readRememberedParams()
    )
    setState({ reloading: true })
    window.setTimeout(() => window.location.reload(), 5000)
  } catch (e) {
    setState({ error: ipcErrorMessage(e) })
  } finally {
    pending = false
  }
}

async function cancel(): Promise<void> {
  if (!state.running?.progress) return
  setState({ ...state, running: { ...state.running, cancelling: true } })
  try {
    await window.studio.cancelLibraryArchive()
  } catch (e) {
    setState({ ...state, error: ipcErrorMessage(e) })
  }
}

const secondary = 'rounded-md border border-line px-4 py-2 transition hover:bg-raised disabled:opacity-40'

const PHASE_TEXT: Record<ArchiveProgress['phase'], string> = {
  preparing: 'Preparing…',
  packing: 'Packing the files…',
  unpacking: 'Unpacking…',
  checking: 'Checking…',
  opening: 'Opening the library…',
  done: 'Done.',
  failed: 'It didn’t work.',
  cancelled: 'Cancelled.'
}

const MB = 1024 ** 2

/** "1.2 GB", "820 MB", "0 MB". */
function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString('en-GB', { maximumFractionDigits: 1 })} GB`
  return `${Math.round(bytes / MB)} MB`
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function countsTitle(c: ArchiveResult['counts']): string {
  return (
    `${c.generations} ${c.generations === 1 ? 'clip' : 'clips'}, ` +
    `${c.assets} characters, environments, products, outfits and poses, ` +
    `${c.sequences} sequences and storyboards, ${c.edits} ${c.edits === 1 ? 'edit' : 'edits'}`
  )
}

/** Export & import (no heading of its own: Settings puts it under one). */
export default function LibraryArchiveSection() {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot)

  const running = s.running
  const progress = running?.progress
  const busy = !!running || !!s.reloading
  const opening = progress?.kind === 'import' && progress.phase === 'opening'

  return (
    <div>
      <p className="mb-3 text-muted">
        Pack the whole library – the database and every file – into a zip file, for example to move it to another
        computer. The API key and the agent’s token aren’t included.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void start('export')} disabled={busy} className={secondary}>
          Export library…
        </button>
        <button onClick={() => void start('import')} disabled={busy} className={secondary}>
          Import a library…
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        The import unpacks the zip file into a new folder and opens the library in it. The library you have open now
        stays where it is, and you can switch back under Library.
      </p>

      {progress && <ProgressBox progress={progress} cancelling={!!running?.cancelling} />}

      {!running && s.exported && (
        <div className="mt-3 text-[12px]">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span className="min-w-0 select-text" title={countsTitle(s.exported.result.counts)}>
              Exported: {fileName(s.exported.result.path)} · {sizeText(Math.max(s.exported.result.bytes, MB))}
              {' · '}
              {s.exported.result.counts.generations} {s.exported.result.counts.generations === 1 ? 'clip' : 'clips'}
            </span>
            <button
              onClick={() => void window.studio.revealFile(s.exported!.result.path)}
              className="text-muted transition hover:text-text"
            >
              Show in Finder
            </button>
          </p>
          {s.exported.note && <p className="mt-1 pl-4 leading-relaxed text-muted select-text">{s.exported.note}</p>}
        </div>
      )}

      {!running && s.cancelled && (
        <p className="mt-3 text-[12px] text-muted">
          {s.cancelled === 'export'
            ? 'The export was cancelled. No zip file was saved.'
            : 'The import was cancelled. What had been unpacked was removed.'}
        </p>
      )}

      {!running && s.error && <p className="mt-3 text-[12px] text-accent select-text">{s.error}</p>}

      <SwitchingOverlay
        phase={s.reloading ? { kind: 'reloading' } : opening ? { kind: 'working', mode: 'open' } : { kind: 'idle' }}
      />
    </div>
  )
}

function ProgressBox({ progress, cancelling }: { progress: ArchiveProgress; cancelling: boolean }) {
  const isExport = progress.kind === 'export'
  const known = !!progress.total && progress.done !== undefined
  const fraction = known ? Math.min(1, progress.done! / progress.total!) : undefined
  // Once an import is moving its folder into place and opening it, it can't be called off.
  const cancellable = progress.phase !== 'opening'

  return (
    <div className="mt-3 rounded-md border border-line bg-raised px-3 py-2.5" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{isExport ? 'Exporting' : 'Importing'}</span>
          <span className="text-muted"> · {progress.message ?? PHASE_TEXT[progress.phase]}</span>
        </span>
        {known && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted">
            {sizeText(progress.done!)} of {sizeText(progress.total!)}
          </span>
        )}
        {cancellable && (
          <button
            onClick={() => void cancel()}
            disabled={cancelling}
            className="shrink-0 text-[12px] text-muted transition hover:text-text disabled:opacity-40"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded bg-bg">
        <div
          className={`h-full bg-accent transition-all duration-500 ${fraction === undefined ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.max(3, (fraction ?? 0.03) * 100)}%` }}
        />
      </div>
      {isExport && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          You can keep working meanwhile. Switching libraries or tidying up the folder structure has to wait until
          the export is done.
        </p>
      )}
    </div>
  )
}
