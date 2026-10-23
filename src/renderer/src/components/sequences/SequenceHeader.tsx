import { useEffect, useState } from 'react'
import type { AssetKind, ExportSummary, Sequence } from '@shared/types'
import { ipcErrorMessage, NO_API_KEY } from '../../lib/hooks'
import { formatUsd } from '../../lib/media'
import { FILE_MANAGER, TRASH } from '../../lib/platform'
import { markAllSeen, useOwnerWork } from '../../lib/work'
import DirectorChip from '../directors/DirectorChip'
import { ScissorsIcon } from '../feed/icons'
import FolderIcon from '../library/FolderIcon'
import { buttonClass } from '../ui/button'
import MoreMenu, { MenuDivider, MenuHeading, MenuItem, MenuRadio } from '../ui/MoreMenu'
import NameInput from '../ui/NameInput'
import { Spinner } from '../work/StatusMark'
import CastButton, { type CastPatch } from './CastPanel'
import { CheckAllIcon, NoteIcon, PlayIcon } from './icons'
import { formatLength } from './sequenceUtils'
import SongChip from './song/SongChip'
import type { TranscribeOptions } from './song/TranscribeLyrics'

interface Props {
  sequence: Sequence
  totalSeconds: number
  readyCount: number
  /** Segments that will get a new take from "Generate missing" (not counting ones already generating). */
  toGenerate: number
  /** Segments still waiting on a take that is already generating. */
  generating: number
  /**
   * Why "Generate missing" can't start now ("Add your Venice API key in Settings", "Clip 2: write a prompt"): it then
   * pays for nothing, so it shows no price and a click shows what stands in the way.
   */
  runBlocked?: string
  runQuote?: number
  stopping: boolean
  /** Where "Generate missing" is ("Clip 2 of 5"), from Activity. */
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
  /** "Export format": 480/720/1080, or null for Automatic. */
  onExportHeight: (height: number | null) => void
  /** "Edit latest export": opens that film in the Editor. */
  onEditExport: (exportId: string) => void
  /** Problems opening the sequence's folder in Finder. */
  onError: (message: string) => void
  /** "Delete sequence…", after its question. */
  onDelete: () => void
  /** A change to the cast (shared/cast.ts); rejects with main's refusal, which the Cast panel shows. */
  onCastChange: (patch: CastPatch) => Promise<void>
  /** Opens the library view of a kind (from the Cast panel's picker). */
  onManageAssets?: (kind: AssetKind) => void
  /** The sequence's director (null: none); rejects with main's refusal, which the Director panel shows. */
  onDirectorChange: (directorId: string | null) => Promise<void>
  /** Opens a director (or, without an id, Directors). */
  onOpenDirector: (directorId?: string) => void
  /** "Add a song…" (a sequence without one) and "Replace the song…": pick a file, then the import dialog. */
  onPickSong: () => void
  /** "Remove the song", after its question; rejects with main's refusal. */
  onRemoveSong: () => Promise<void>
  /** The song's steps from the Song panel (separating is free, transcribing paid); reject with main's refusal. */
  onSeparateSong: () => Promise<unknown>
  onTranscribeSong: (opts: TranscribeOptions) => Promise<unknown>
}

/** The heights "Export format" offers; Automatic (null) keeps the first clip's own size. */
const EXPORT_FORMATS: { height: number | null; label: string; text: string }[] = [
  { height: null, label: 'Automatic', text: "First clip's size" },
  { height: 480, label: '480p', text: 'Small file' },
  { height: 720, label: '720p', text: 'HD' },
  { height: 1080, label: '1080p', text: 'Full HD' }
]

/** "720p" / "Automatic", for the export button's tooltip. */
function exportFormatLabel(height: number | null | undefined): string {
  return EXPORT_FORMATS.find((f) => f.height === (height ?? null))?.label ?? 'Automatic'
}

/**
 * "Generate missing"'s tooltip while there is something to send, the same in the Sequences and Storyboards headers:
 * what stands in the way (a click shows it, or opens Settings for the missing key), else what it does.
 */
export function runTitle(runBlocked: string | undefined, does: string): string {
  if (runBlocked === NO_API_KEY) return `${NO_API_KEY} – click to open Settings`
  if (runBlocked) return `${runBlocked}. Nothing is sent until every missing clip can be generated – click to show it.`
  return does
}

/**
 * Name, length and the sequence-wide actions, inside the window's drag bar, in the order every film header has:
 * the name, the Song, Cast and Director chips, then Generate missing, Preview and Export (the next step in the accent
 * colour) and ⋯ with the rarer ones.
 */
export default function SequenceHeader({
  sequence,
  totalSeconds,
  readyCount,
  toGenerate,
  generating,
  runBlocked,
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
  onError,
  onDelete,
  onCastChange,
  onManageAssets,
  onDirectorChange,
  onOpenDirector,
  onPickSong,
  onRemoveSong,
  onSeparateSong,
  onTranscribeSong
}: Props) {
  const count = sequence.segments.length
  const exporting = exportProgress !== undefined
  // The button for the next sensible step gets the accent colour.
  const exportIsNext = count > 0 && toGenerate === 0 && generating === 0 && !exportBlocked
  // Counted always, but priced and in the accent colour only when it can start; until then a click shows why not.
  const runReady = toGenerate > 0 && !runBlocked

  return (
    <div className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line pl-3 pr-4">
      <NameInput
        value={sequence.name}
        onRename={onRename}
        placeholder="Untitled sequence"
        ariaLabel="Sequence name"
        autoFocus={autoFocusName}
        onAutoFocused={onAutoFocused}
      />
      {/* Only when the main area is wide: the list beside it shows the same, and the actions need the room. */}
      <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-muted @min-[83rem]/main:inline">
        {formatLength(totalSeconds)}
        <span className="mx-1.5">·</span>
        {readyCount === count
          ? `${count} ${count === 1 ? 'clip' : 'clips'}`
          : `${readyCount} of ${count} ${count === 1 ? 'clip' : 'clips'} ready`}
      </span>

      <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
        {sequence.song && (
          <SongChip
            sequence={sequence}
            onReplace={onPickSong}
            onRemove={onRemoveSong}
            onSeparate={onSeparateSong}
            onTranscribe={onTranscribeSong}
            onError={onError}
          />
        )}
        <CastButton sequence={sequence} onChange={onCastChange} onManage={onManageAssets} />
        <DirectorChip
          directorId={sequence.director}
          what="sequence"
          intro={
            'Directs every clip that doesn’t choose otherwise: its direction is added to their prompts. Choosing one ' +
            'sets its defaults, shot length and what happens between shots for new clips – existing clips aren’t changed.'
          }
          exceptions={directorExceptions(sequence)}
          onChange={onDirectorChange}
          onOpen={onOpenDirector}
        />
        {sequence.running ? (
          <>
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted" aria-live="polite">
              <Spinner className="text-text" />
              Generating missing…
              {runDetail && <span className="tabular-nums">{runDetail}</span>}
            </span>
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className={buttonClass()}
              title="Stops after the clip being generated now"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </>
        ) : (
          // Only while something is missing: with every clip done, Export is the one next step.
          (toGenerate > 0 || generating > 0) && (
            <button
              type="button"
              onClick={onGenerateAll}
              disabled={toGenerate === 0}
              className={buttonClass(runReady ? 'primary' : 'secondary')}
              title={
                toGenerate > 0
                  ? runTitle(runBlocked, 'Generates a take for every clip that has none, in order')
                  : 'The missing takes are already being generated'
              }
            >
              Generate missing{toGenerate > 0 && ` (${toGenerate})`}
              {runReady && <span className="tabular-nums opacity-80">· {formatUsd(runQuote)}</span>}
            </button>
          )
        )}

        <button
          type="button"
          onClick={onPreview}
          disabled={!!previewDisabled}
          title={previewDisabled ?? 'Play the clips in order'}
          className={buttonClass()}
        >
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
            <span className="w-9 text-right text-[12px] tabular-nums text-muted">
              {Math.round(exportProgress * 100)}%
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onExport}
            disabled={!!exportBlocked}
            title={
              exportBlocked ??
              `Joins the clips into one MP4 file (Export format: ${exportFormatLabel(sequence.exportHeight)})`
            }
            className={buttonClass(exportIsNext ? 'primary' : 'secondary')}
          >
            Export
          </button>
        )}

        <SequenceMenu
          sequence={sequence}
          exporting={exporting}
          onExportHeight={onExportHeight}
          onEditExport={onEditExport}
          onError={onError}
          onDelete={onDelete}
          onAddSong={onPickSong}
        />
      </div>
    </div>
  )
}

/** "1", "1 and 3", "1, 3 and 4". */
function numbers(list: readonly number[]): string {
  return list.length === 1 ? `${list[0]}` : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * "Clip 3 has a director of its own · clip 5 has none": the clips that don't follow the sequence's director (or, in a
 * sequence without one, that have one of their own); undefined when every clip follows it.
 */
export function directorExceptions(sequence: Sequence): string | undefined {
  const own: number[] = []
  const none: number[] = []
  sequence.segments.forEach((s, i) => {
    const d = s.params.director
    if (d === null && sequence.director) none.push(i + 1)
    else if (typeof d === 'string' && d && d !== sequence.director) own.push(i + 1)
  })
  const parts = [
    own.length
      ? `${own.length === 1 ? 'Clip' : 'Clips'} ${numbers(own)} ${own.length === 1 ? 'has a director' : 'have directors'} of ${own.length === 1 ? 'its' : 'their'} own`
      : '',
    none.length ? `${none.length === 1 ? 'clip' : 'clips'} ${numbers(none)} ${none.length === 1 ? 'has' : 'have'} none` : ''
  ].filter(Boolean)
  if (!parts.length) return undefined
  const text = parts.join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1) + '.'
}

/** The newest export of a sequence or storyboard whose film is still there, if any. */
async function latestExport(ownerId: string): Promise<ExportSummary | undefined> {
  const exports = await window.studio.listExports()
  return exports
    .filter((e) => e.sequenceId === ownerId && e.exists)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/** What deleting a sequence does, for its question in ⋯ and in the list's row alike. */
export const DELETE_SEQUENCE_TEXT = `The takes stay in Media and exported films in their folder; the sequence's images that nothing else uses are moved to ${TRASH}.`

/**
 * ⋯ → "Edit latest export", shared by the film headers: the newest export still on disk, looked up each time the menu
 * opens (it mounts with the menu) – an export may have finished, or its film been deleted, since.
 */
export function LatestExportItem({
  ownerId,
  exporting,
  untouched,
  onEdit,
  onError
}: {
  ownerId: string
  exporting: boolean
  /** "The sequence isn't touched." */
  untouched: string
  onEdit: (exportId: string) => void
  onError?: (message: string) => void
}) {
  // undefined while looking, null when there is no export (yet).
  const [latest, setLatest] = useState<ExportSummary | null>()
  useEffect(() => {
    let current = true
    setLatest(undefined)
    latestExport(ownerId).then(
      (e) => current && setLatest(e ?? null),
      (e: unknown) => {
        if (!current) return
        setLatest(null)
        onError?.(ipcErrorMessage(e))
      }
    )
    return () => {
      current = false
    }
  }, [ownerId, exporting])
  return (
    <MenuItem
      icon={<ScissorsIcon size={13} />}
      disabled={!latest}
      onSelect={() => latest && onEdit(latest.id)}
      hint={
        latest === undefined
          ? 'Looking for the export…'
          : latest === null
            ? 'Export first.'
            : `Change the finished film with AI in the Editor. ${untouched}`
      }
    >
      Edit latest export
    </MenuItem>
  )
}

/** ⋯ → "Open folder", shared by the film headers: the sequence's or storyboard's own folder in Finder. */
export function OpenFolderItem({
  target,
  id,
  onError
}: {
  target: 'sequences' | 'storyboards'
  id: string
  onError: (message: string) => void
}) {
  return (
    <MenuItem
      icon={<FolderIcon size={13} />}
      title={`Open the folder in ${FILE_MANAGER}`}
      onSelect={() => {
        window.studio.revealLibraryFolder(target, id).catch((e: unknown) => onError(ipcErrorMessage(e)))
      }}
    >
      Open folder
    </MenuItem>
  )
}

/** ⋯ → "Mark all as seen", shared by the film headers: the New marks of everything in the sequence or storyboard. */
export function MarkAllSeenItem({ ownerId, what }: { ownerId: string; what: 'sequence' | 'storyboard' }) {
  const news = useOwnerWork(ownerId)
  const count = news.unseen + news.failed
  return (
    <MenuItem
      icon={<CheckAllIcon size={13} />}
      disabled={count === 0}
      onSelect={() => void markAllSeen({ ownerId })}
      hint={
        count === 0
          ? `Nothing new to look at in the ${what}.`
          : `Removes the New mark from ${count === 1 ? 'the new item' : `${count} items`} in the ${what}.`
      }
    >
      Mark all as seen
    </MenuItem>
  )
}

/**
 * ⋯: the Export format, then the latest export into the Editor, the folder, marking what is new here as seen, a song
 * for a sequence without one, and deleting it (asked in the menu).
 */
function SequenceMenu({
  sequence,
  exporting,
  onExportHeight,
  onEditExport,
  onError,
  onDelete,
  onAddSong
}: {
  sequence: Sequence
  exporting: boolean
  onExportHeight: (height: number | null) => void
  onEditExport: (exportId: string) => void
  onError: (message: string) => void
  onDelete: () => void
  onAddSong: () => void
}) {
  const height = sequence.exportHeight ?? null
  return (
    <MoreMenu width={290}>
      {(menu) => (
        <>
          <MenuHeading>Export format</MenuHeading>
          {EXPORT_FORMATS.map((f) => (
            <MenuRadio
              key={f.label}
              checked={height === f.height}
              onSelect={() => onExportHeight(f.height)}
              hint={f.text}
            >
              {f.label}
            </MenuRadio>
          ))}
          <p className="px-2.5 pb-1.5 pt-0.5 text-[11px] leading-snug text-muted">
            The film gets the first clip's aspect ratio at that height.
          </p>
          <MenuDivider />
          <LatestExportItem
            ownerId={sequence.id}
            exporting={exporting}
            untouched="The sequence isn't touched."
            onEdit={onEditExport}
            onError={onError}
          />
          <OpenFolderItem target="sequences" id={sequence.id} onError={onError} />
          <MarkAllSeenItem ownerId={sequence.id} what="sequence" />
          {!sequence.song && (
            <MenuItem
              icon={<NoteIcon size={13} />}
              onSelect={onAddSong}
              hint="Cut the sequence to a song: every clip gets a place in it, and the film plays the song."
            >
              Add a song…
            </MenuItem>
          )}
          <MenuDivider />
          <MenuItem
            danger
            onSelect={() =>
              menu.confirm({ question: `Delete “${sequence.name}”?`, note: DELETE_SEQUENCE_TEXT, onConfirm: onDelete })
            }
          >
            Delete sequence…
          </MenuItem>
        </>
      )}
    </MoreMenu>
  )
}
