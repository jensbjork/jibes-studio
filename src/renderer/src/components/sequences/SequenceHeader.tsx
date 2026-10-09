import { useEffect, useRef, useState } from 'react'
import type { ExportSummary, Sequence } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatSeconds, formatUsd } from '../../lib/media'
import { markAllSeen, useOwnerWork } from '../../lib/work'
import { ScissorsIcon } from '../feed/icons'
import OpenFolderButton from '../library/OpenFolderButton'
import Popover from '../pickers/Popover'
import { menuRow, onMenuKeyDown } from '../storyboards/ui'
import { Spinner } from '../work/StatusMark'
import { CheckAllIcon, MoreIcon, PlayIcon } from './icons'

interface Props {
  sequence: Sequence
  totalSeconds: number
  readyCount: number
  /** Segments that will get a new take from "Generera saknade" (not counting ones already generating). */
  toGenerate: number
  /** Segments still waiting on a take that is already generating. */
  generating: number
  runQuote?: number
  stopping: boolean
  /** Where "Generera saknade" is ("Klipp 2 av 5"), from Pågår och klart. */
  runDetail?: string
  previewDisabled?: string
  /** 0–1 while the film is exported (also an export started elsewhere); undefined otherwise. */
  exportProgress?: number
  exportBlocked?: string
  autoFocusName: boolean
  onAutoFocused: () => void
  onRename: (name: string) => void
  onGenerateAll: () => void
  onStop: () => void
  onPreview: () => void
  onExport: () => void
  /** "Exportformat": 480/720/1080, or null for Automatiskt. */
  onExportHeight: (height: number | null) => void
  /** "Redigera senaste exporten": opens that film in Redigera. */
  onEditExport: (exportId: string) => void
  /** Problems opening the sequence's folder in Finder. */
  onError: (message: string) => void
}

/** The heights "Exportformat" offers; Automatiskt (null) keeps the first clip's own size. */
const EXPORT_FORMATS: { height: number | null; label: string; text: string }[] = [
  { height: null, label: 'Automatiskt', text: 'Första klippets storlek' },
  { height: 480, label: '480p', text: 'Liten fil' },
  { height: 720, label: '720p', text: 'HD' },
  { height: 1080, label: '1080p', text: 'Full HD' }
]

/** "720p" / "Automatiskt", for the export button's tooltip. */
function exportFormatLabel(height: number | null | undefined): string {
  return EXPORT_FORMATS.find((f) => f.height === (height ?? null))?.label ?? 'Automatiskt'
}

const primary =
  'flex items-center gap-1.5 whitespace-nowrap rounded-md bg-accent px-3 py-1.5 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40'
const secondary =
  'flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'

/** Name, length and the sequence-wide actions, inside the window's drag bar. */
export default function SequenceHeader({
  sequence,
  totalSeconds,
  readyCount,
  toGenerate,
  generating,
  runQuote,
  stopping,
  runDetail,
  previewDisabled,
  exportProgress,
  exportBlocked,
  autoFocusName,
  onAutoFocused,
  onRename,
  onGenerateAll,
  onStop,
  onPreview,
  onExport,
  onExportHeight,
  onEditExport,
  onError
}: Props) {
  const count = sequence.segments.length
  const exporting = exportProgress !== undefined
  // The button for the next sensible step gets the accent colour.
  const exportIsNext = toGenerate === 0 && generating === 0 && count > 0

  return (
    <div className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line pl-3 pr-4">
      <NameInput name={sequence.name} onRename={onRename} autoFocus={autoFocusName} onAutoFocused={onAutoFocused} />
      {/* Only when the main area is wide: the list beside it shows the same, and the actions need the room. */}
      <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-muted @min-[83rem]/main:inline">
        {formatSeconds(totalSeconds * 1000)}
        <span className="mx-1.5">·</span>
        {readyCount === count ? `${count} klipp` : `${readyCount} av ${count} klipp klara`}
      </span>

      <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
        <OpenFolderButton
          target="sequences"
          id={sequence.id}
          compact
          title="Visa sekvensens mapp med tagningar och exporter i Finder"
          onError={onError}
          className="rounded-md px-2 py-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
        />
        {sequence.running ? (
          <>
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted" aria-live="polite">
              <Spinner className="text-text" />
              Genererar saknade…
              {runDetail && <span className="tabular-nums">{runDetail}</span>}
            </span>
            <button onClick={onStop} disabled={stopping} className={secondary} title="Stoppar efter klippet som genereras nu">
              {stopping ? 'Stoppar…' : 'Stoppa'}
            </button>
          </>
        ) : (
          <button
            onClick={onGenerateAll}
            disabled={toGenerate === 0}
            className={exportIsNext || toGenerate === 0 ? secondary : primary}
            title={
              toGenerate > 0
                ? 'Genererar en tagning för varje klipp som saknar en, i ordning'
                : generating > 0
                  ? 'Tagningarna som saknas genereras redan'
                  : 'Alla klipp har en färdig vald tagning'
            }
          >
            Generera saknade{toGenerate > 0 && ` (${toGenerate})`}
            {toGenerate > 0 && <span className="opacity-75">· {formatUsd(runQuote)}</span>}
          </button>
        )}

        <button onClick={onPreview} disabled={!!previewDisabled} title={previewDisabled ?? 'Spela upp klippen i följd'} className={secondary}>
          <PlayIcon size={11} />
          <span className="hidden @min-[67rem]/main:inline">Förhandsvisa</span>
        </button>

        {exporting ? (
          <div className="flex w-36 items-center gap-2" title="Exporterar med ffmpeg" role="status" aria-label="Exporterar">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.max(2, exportProgress * 100)}%` }}
              />
            </div>
            <span className="w-9 text-right text-[12px] tabular-nums text-muted">
              {Math.round(exportProgress * 100)} %
            </span>
          </div>
        ) : (
          <button
            onClick={onExport}
            disabled={!!exportBlocked}
            title={
              exportBlocked ??
              `Renderar hela sekvensen till en mp4-fil (Exportformat: ${exportFormatLabel(sequence.exportHeight)})`
            }
            className={exportIsNext ? primary : secondary}
          >
            Exportera
          </button>
        )}

        <MoreMenu
          sequence={sequence}
          exporting={exporting}
          onExportHeight={onExportHeight}
          onEditExport={onEditExport}
          onError={onError}
        />
      </div>
    </div>
  )
}

/** The newest export of the sequence whose film is still there, if any. */
async function latestExport(sequenceId: string): Promise<ExportSummary | undefined> {
  const exports = await window.studio.listExports()
  return exports
    .filter((e) => e.sequenceId === sequenceId && e.exists)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/** ⋯: the Exportformat, the latest export into Redigera, and marking what is new here as seen. */
function MoreMenu({
  sequence,
  exporting,
  onExportHeight,
  onEditExport,
  onError
}: {
  sequence: Sequence
  exporting: boolean
  onExportHeight: (height: number | null) => void
  onEditExport: (exportId: string) => void
  onError: (message: string) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // undefined while looking, null when the sequence has no export (yet).
  const [latest, setLatest] = useState<ExportSummary | null>()
  const news = useOwnerWork(sequence.id)
  const newCount = news.unseen + news.failed
  const newWhat = newCount === 1 ? 'det som är nytt' : `${newCount} saker`

  // Looked up each time the menu opens: an export may have finished (or its film been deleted) since.
  useEffect(() => {
    if (!open) return
    let current = true
    setLatest(undefined)
    latestExport(sequence.id).then(
      (e) => current && setLatest(e ?? null),
      (e: unknown) => {
        if (!current) return
        setLatest(null)
        onError(ipcErrorMessage(e))
      }
    )
    return () => {
      current = false
    }
  }, [open, sequence.id, exporting])

  const height = sequence.exportHeight ?? null

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Fler val"
        title="Fler val"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
      >
        <MoreIcon size={14} />
      </button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="end" width={280} label="Fler val">
        <div role="menu" aria-label="Fler val" onKeyDown={onMenuKeyDown} className="p-1">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Exportformat
          </p>
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.label}
              type="button"
              role="menuitemradio"
              aria-checked={height === f.height}
              data-menu-item
              autoFocus={height === f.height}
              onClick={() => {
                setOpen(false)
                if (height !== f.height) onExportHeight(f.height)
              }}
              className={menuRow}
            >
              <span className={`w-3 shrink-0 text-accent ${height === f.height ? '' : 'invisible'}`}>✓</span>
              <span className="flex-1">{f.label}</span>
              <span className="text-[11px] text-muted">{f.text}</span>
            </button>
          ))}
          <p className="px-2.5 pb-1.5 pt-0.5 text-[11px] leading-snug text-muted">
            Filmen får första klippets bildformat i den höjden.
          </p>
          <div className="mx-2 my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            data-menu-item
            disabled={!latest}
            title={latest === null ? 'Exportera först' : undefined}
            onClick={() => {
              if (!latest) return
              setOpen(false)
              onEditExport(latest.id)
            }}
            className={`${menuRow} flex-col items-start gap-0.5`}
          >
            <span className="flex items-center gap-2">
              <ScissorsIcon size={13} className="shrink-0 text-muted" />
              Redigera senaste exporten
            </span>
            <span className="pl-[21px] text-[11px] leading-snug text-muted">
              {latest === undefined
                ? 'Letar efter exporten…'
                : latest === null
                  ? 'Exportera först.'
                  : 'Ändra den färdiga filmen med AI i Redigera. Sekvensen rörs inte.'}
            </span>
          </button>
          <div className="mx-2 my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            data-menu-item
            disabled={newCount === 0}
            onClick={() => {
              setOpen(false)
              void markAllSeen({ ownerId: sequence.id })
            }}
            className={`${menuRow} flex-col items-start gap-0.5`}
          >
            <span className="flex items-center gap-2">
              <CheckAllIcon size={13} className="shrink-0 text-muted" />
              Markera alla som sedda
            </span>
            <span className="pl-[21px] text-[11px] leading-snug text-muted">
              {newCount === 0
                ? 'Inget nytt att titta på i sekvensen.'
                : `Tar bort markeringen Ny från ${newWhat} i sekvensen.`}
            </span>
          </button>
        </div>
      </Popover>
    </>
  )
}

function NameInput({
  name,
  onRename,
  autoFocus,
  onAutoFocused
}: {
  name: string
  onRename: (name: string) => void
  autoFocus: boolean
  onAutoFocused: () => void
}) {
  const [value, setValue] = useState(name)
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!focused) setValue(name)
  }, [name, focused])

  useEffect(() => {
    if (!autoFocus) return
    input.current?.focus()
    input.current?.select()
    onAutoFocused()
  }, [autoFocus])

  const commit = () => {
    const next = value.trim()
    if (!next || next === name) setValue(name)
    else onRename(next)
  }

  return (
    <input
      ref={input}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (cancelled.current) cancelled.current = false
        else commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          setValue(name)
          e.currentTarget.blur()
        }
      }}
      spellCheck={false}
      placeholder="Namnlös sekvens"
      title="Byt namn"
      className="no-drag min-w-0 max-w-sm flex-1 truncate rounded-md @min-[67rem]/main:min-w-28 border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold outline-none transition hover:border-line focus:border-muted focus:bg-raised"
    />
  )
}
