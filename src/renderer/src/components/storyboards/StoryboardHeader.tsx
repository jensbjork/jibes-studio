import { useEffect, useRef, useState } from 'react'
import type { ExportSummary, Storyboard } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatUsd } from '../../lib/media'
import { markAllSeen, useOwnerWork } from '../../lib/work'
import { ScissorsIcon } from '../feed/icons'
import FolderIcon from '../library/FolderIcon'
import Popover from '../pickers/Popover'
import { CheckAllIcon, MoreIcon, PlayIcon } from '../sequences/icons'
import { Spinner } from '../work/StatusMark'
import { aspectLabel, clipProgressLabel, formatLength, STORYBOARD_ASPECTS } from './storyboardUtils'
import { menuRow, onMenuKeyDown, primaryButton, secondaryButton } from './ui'

interface Props {
  storyboard: Storyboard
  /** Seconds of the film so far (the selected, finished takes). */
  totalSeconds: number
  /** Transitions with a finished selected take. */
  doneCount: number
  /** Transitions "Generate missing" would send now. */
  toGenerate: number
  /** Transitions missing a take that already have one on its way. */
  generating: number
  /** Why "Generate missing" can't start now ("Transition 1: board 1 has no image"): it then pays for nothing. */
  runBlocked?: string
  runQuote?: number
  stopping: boolean
  /** Where "Generate missing" is, from Activity. */
  runDetail?: string
  previewDisabled?: string
  /** 0–1 while the film is exported (also an export started elsewhere); undefined otherwise. */
  exportProgress?: number
  exportBlocked?: string
  converting: boolean
  autoFocusName: boolean
  onAutoFocused: () => void
  onRename: (name: string) => void
  onAspectRatio: (aspectRatio: string) => void
  onGenerateAll: () => void
  onStop: () => void
  onPreview: () => void
  onExport: () => void
  onConvert: () => void
  onDelete: () => void
  /** "Edit latest export": opens that film in the Editor. */
  onEditExport: (exportId: string) => void
  onError: (message: string) => void
}

/** Name, format and the storyboard-wide actions, inside the window's drag bar. */
export default function StoryboardHeader({
  storyboard,
  totalSeconds,
  doneCount,
  toGenerate,
  generating,
  runBlocked,
  runQuote,
  stopping,
  runDetail,
  previewDisabled,
  exportProgress,
  exportBlocked,
  converting,
  autoFocusName,
  onAutoFocused,
  onRename,
  onAspectRatio,
  onGenerateAll,
  onStop,
  onPreview,
  onExport,
  onConvert,
  onDelete,
  onEditExport,
  onError
}: Props) {
  const count = storyboard.transitions.length
  const exporting = exportProgress !== undefined
  // The button for the next sensible step gets the accent colour.
  const exportIsNext = count > 0 && toGenerate === 0 && generating === 0 && !exportBlocked
  // Counted and priced only when it can start; until then a click shows what stands in the way.
  const runReady = toGenerate > 0 && !runBlocked
  const aspects: string[] = STORYBOARD_ASPECTS.includes(storyboard.aspectRatio as (typeof STORYBOARD_ASPECTS)[number])
    ? [...STORYBOARD_ASPECTS]
    : [storyboard.aspectRatio, ...STORYBOARD_ASPECTS]

  return (
    <div className="drag flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3 pr-3">
      <NameInput name={storyboard.name} onRename={onRename} autoFocus={autoFocusName} onAutoFocused={onAutoFocused} />
      <select
        value={storyboard.aspectRatio}
        onChange={(e) => onAspectRatio(e.target.value)}
        title={`The film’s format: ${aspectLabel(storyboard.aspectRatio)}. New images are created in this format.`}
        aria-label="Format"
        className="no-drag shrink-0 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12px] text-muted outline-none transition hover:border-line hover:text-text focus:border-muted"
      >
        {aspects.map((a) => (
          <option key={a} value={a} title={aspectLabel(a)}>
            {a}
          </option>
        ))}
      </select>
      {/* Only when the main area is wide: the list beside it shows the same, and the actions need the room. */}
      {count > 0 && (
        <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-muted @min-[83rem]/main:inline">
          {clipProgressLabel(doneCount, count)}
          {totalSeconds > 0 && ` · ${formatLength(totalSeconds)}`}
        </span>
      )}

      <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
        {storyboard.running ? (
          <>
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted" aria-live="polite">
              <Spinner className="text-text" />
              Sending missing clips…
              {runDetail && <span className="tabular-nums">{runDetail}</span>}
            </span>
            <button onClick={onStop} disabled={stopping} className={secondaryButton} title="Send no more clips">
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </>
        ) : (
          count > 0 && (
            <button
              onClick={onGenerateAll}
              disabled={toGenerate === 0}
              className={exportIsNext || !runReady ? secondaryButton : primaryButton}
              title={
                runBlocked
                  ? `${runBlocked}. Nothing is sent until every missing clip can be generated – click to show it.`
                  : toGenerate > 0
                    ? 'Generates every missing clip – they don’t depend on each other and are sent right away'
                    : generating > 0
                      ? 'The missing clips are already being generated'
                      : 'Every transition has a finished clip'
              }
            >
              Generate missing{runReady && ` (${toGenerate})`}
              {runReady && <span className="opacity-75">· {formatUsd(runQuote)}</span>}
            </button>
          )
        )}

        <button onClick={onPreview} disabled={!!previewDisabled} title={previewDisabled ?? 'Play the clips in order'} className={secondaryButton}>
          <PlayIcon size={11} />
          <span className="hidden @min-[67rem]/main:inline">Preview</span>
        </button>

        {exporting ? (
          <div className="flex w-36 items-center gap-2" title="Exporting with ffmpeg" role="status" aria-label="Exporting">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.max(2, exportProgress * 100)}%` }}
              />
            </div>
            <span className="w-9 text-right text-[12px] tabular-nums text-muted">{Math.round(exportProgress * 100)}%</span>
          </div>
        ) : (
          <button
            onClick={onExport}
            disabled={!!exportBlocked}
            title={exportBlocked ?? 'Joins the clips into one MP4 file'}
            className={exportIsNext ? primaryButton : secondaryButton}
          >
            Export
          </button>
        )}

        <MoreMenu
          storyboard={storyboard}
          converting={converting}
          exporting={exporting}
          onConvert={onConvert}
          onDelete={onDelete}
          onEditExport={onEditExport}
          onError={onError}
        />
      </div>
    </div>
  )
}

/** The newest export of the storyboard whose film is still there, if any. */
async function latestExport(storyboardId: string): Promise<ExportSummary | undefined> {
  const exports = await window.studio.listExports()
  return exports
    .filter((e) => e.sequenceId === storyboardId && e.exists)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/**
 * The rarer actions: continue in Sequences, the latest export into the Editor, the folder in Finder, marking what is
 * new here as seen, deleting (asked twice).
 */
function MoreMenu({
  storyboard,
  converting,
  exporting,
  onConvert,
  onDelete,
  onEditExport,
  onError
}: {
  storyboard: Storyboard
  converting: boolean
  exporting: boolean
  onConvert: () => void
  onDelete: () => void
  onEditExport: (exportId: string) => void
  onError: (message: string) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // undefined while looking, null when there is no export (yet).
  const [latest, setLatest] = useState<ExportSummary | null>()
  const news = useOwnerWork(storyboard.id)
  const newCount = news.unseen + news.failed
  const newWhat = newCount === 1 ? 'the new item' : `${newCount} items`
  const close = () => {
    setOpen(false)
    setConfirming(false)
  }

  // Looked up each time the menu opens: an export may have finished (or its film been deleted) since.
  useEffect(() => {
    if (!open) return
    let current = true
    setLatest(undefined)
    latestExport(storyboard.id).then(
      (e) => current && setLatest(e ?? null),
      () => current && setLatest(null)
    )
    return () => {
      current = false
    }
  }, [open, storyboard.id, exporting])

  const reveal = async () => {
    close()
    try {
      await window.studio.revealLibraryFolder('storyboards', storyboard.id)
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More options"
        title="More options"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
      >
        <MoreIcon size={14} />
      </button>
      <Popover anchorRef={anchor} open={open} onClose={close} align="end" width={290} label="More options">
        {confirming ? (
          <div className="p-3">
            <p className="mb-1 truncate">Delete “{storyboard.name}”?</p>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">
              The boards and transitions are removed. The clips stay in Media, and finished films stay in the
              folder. The storyboard’s images that nothing else uses are moved to the Trash.
            </p>
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  close()
                  onDelete()
                }}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div role="menu" aria-label="More options" onKeyDown={onMenuKeyDown} className="p-1">
            <button
              type="button"
              role="menuitem"
              data-menu-item
              autoFocus
              disabled={converting || storyboard.transitions.length === 0}
              onClick={() => {
                close()
                onConvert()
              }}
              className={`${menuRow} flex-col items-start gap-0.5`}
            >
              <span>{converting ? 'Converting to sequence…' : 'Convert to sequence'}</span>
              <span className="text-[11px] leading-snug text-muted">
                A new sequence with one clip per transition, to keep editing in Sequences. The storyboard stays.
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              disabled={!latest}
              onClick={() => {
                if (!latest) return
                close()
                onEditExport(latest.id)
              }}
              className={`${menuRow} flex-col items-start gap-0.5`}
            >
              <span className="flex items-center gap-2">
                <ScissorsIcon size={13} className="shrink-0 text-muted" />
                Edit latest export
              </span>
              <span className="pl-[21px] text-[11px] leading-snug text-muted">
                {latest === undefined
                  ? 'Looking for the export…'
                  : latest === null
                    ? 'Export first.'
                    : 'Change the finished film with AI in the Editor. The storyboard stays as it is.'}
              </span>
            </button>
            <button type="button" role="menuitem" data-menu-item onClick={() => void reveal()} className={menuRow}>
              <FolderIcon size={13} className="shrink-0 text-muted" />
              Open folder in Finder
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              disabled={newCount === 0}
              onClick={() => {
                close()
                void markAllSeen({ ownerId: storyboard.id })
              }}
              className={`${menuRow} flex-col items-start gap-0.5`}
            >
              <span className="flex items-center gap-2">
                <CheckAllIcon size={13} className="shrink-0 text-muted" />
                Mark all as seen
              </span>
              <span className="pl-[21px] text-[11px] leading-snug text-muted">
                {newCount === 0
                  ? 'Nothing new to look at in the storyboard.'
                  : `Removes the New mark from ${newWhat} in the storyboard.`}
              </span>
            </button>
            <div className="mx-2 my-1 border-t border-line" />
            <button
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => setConfirming(true)}
              className={`${menuRow} text-muted hover:text-accent`}
            >
              Delete storyboard…
            </button>
          </div>
        )}
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
      placeholder="Untitled storyboard"
      title="Rename"
      aria-label="Storyboard name"
      className="no-drag min-w-0 max-w-sm flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold outline-none transition hover:border-line focus:border-muted focus:bg-raised @min-[67rem]/main:min-w-28"
    />
  )
}
