import type { Storyboard } from '@shared/types'
import { formatUsd } from '../../lib/media'
import DirectorChip from '../directors/DirectorChip'
import { PlayIcon } from '../sequences/icons'
import { LatestExportItem, MarkAllSeenItem, OpenFolderItem, runTitle } from '../sequences/SequenceHeader'
import { buttonClass } from '../ui/button'
import MoreMenu, { MenuDivider, MenuHeading, MenuItem, MenuRadio } from '../ui/MoreMenu'
import NameInput from '../ui/NameInput'
import { Spinner } from '../work/StatusMark'
import {
  aspectLabel,
  aspectShape,
  clipProgressLabel,
  DELETE_STORYBOARD_TEXT,
  formatLength,
  STORYBOARD_ASPECTS
} from './storyboardUtils'

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
  /**
   * Why "Generate missing" can't start now ("Add your Venice API key in Settings", "Transition 1: board 1 has no
   * image"): it then pays for nothing, so it shows no price and a click shows what stands in the way.
   */
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
  /** ⋯ → Format. */
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
  /** The storyboard's director (null: none); rejects with main's refusal, which the Director panel shows. */
  onDirectorChange: (directorId: string | null) => Promise<void>
  /** Opens a director (or, without an id, Directors). */
  onOpenDirector: (directorId?: string) => void
}

/**
 * Name and the storyboard-wide actions, inside the window's drag bar, in the order every film header has: the name,
 * the Director chip, then Generate missing, Preview and Export (the next step in the accent colour) and ⋯ with the
 * format and the rarer actions.
 */
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
  onError,
  onDirectorChange,
  onOpenDirector
}: Props) {
  const count = storyboard.transitions.length
  const exporting = exportProgress !== undefined
  // The button for the next sensible step gets the accent colour.
  const exportIsNext = count > 0 && toGenerate === 0 && generating === 0 && !exportBlocked
  // Counted always, but priced and in the accent colour only when it can start; until then a click shows why not.
  const runReady = toGenerate > 0 && !runBlocked

  return (
    <div className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line pl-3 pr-4">
      <NameInput
        value={storyboard.name}
        onRename={onRename}
        placeholder="Untitled storyboard"
        ariaLabel="Storyboard name"
        autoFocus={autoFocusName}
        onAutoFocused={onAutoFocused}
      />
      {/* Only when the main area is wide: the actions need the room (the list beside it has the clips done). */}
      {count > 0 && (
        <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-muted @min-[83rem]/main:inline">
          {clipProgressLabel(doneCount, count)}
          {totalSeconds > 0 && ` · ${formatLength(totalSeconds)}`}
        </span>
      )}

      <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
        <DirectorChip
          directorId={storyboard.director}
          what="storyboard"
          intro={
            'Directs every transition: its direction is added to their prompts and its look, light and framing to the ' +
            'pictures you create for the boards. Choosing one sets its defaults for new transitions – existing ones ' +
            'aren’t changed.'
          }
          onChange={onDirectorChange}
          onOpen={onOpenDirector}
        />
        {storyboard.running ? (
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
              title="Sends no more clips – ones already sent keep generating"
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
                  ? runTitle(
                      runBlocked,
                      'Generates every missing clip – they don’t depend on each other and are sent right away'
                    )
                  : 'The missing clips are already being generated'
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
            <span className="w-9 text-right text-[12px] tabular-nums text-muted">{Math.round(exportProgress * 100)}%</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onExport}
            disabled={!!exportBlocked}
            title={exportBlocked ?? `Joins the clips into one MP4 file (Format: ${aspectLabel(storyboard.aspectRatio)})`}
            className={buttonClass(exportIsNext ? 'primary' : 'secondary')}
          >
            Export
          </button>
        )}

        <StoryboardMenu
          storyboard={storyboard}
          converting={converting}
          exporting={exporting}
          onAspectRatio={onAspectRatio}
          onConvert={onConvert}
          onDelete={onDelete}
          onEditExport={onEditExport}
          onError={onError}
        />
      </div>
    </div>
  )
}

/**
 * ⋯: the Format, then continuing in Sequences, the latest export into the Editor, the folder, marking what is new
 * here as seen, and deleting (asked in the menu).
 */
function StoryboardMenu({
  storyboard,
  converting,
  exporting,
  onAspectRatio,
  onConvert,
  onDelete,
  onEditExport,
  onError
}: {
  storyboard: Storyboard
  converting: boolean
  exporting: boolean
  onAspectRatio: (aspectRatio: string) => void
  onConvert: () => void
  onDelete: () => void
  onEditExport: (exportId: string) => void
  onError: (message: string) => void
}) {
  // A ratio outside the usual ones (an agent can set any) is listed first, so the menu always shows the one in use.
  const aspects: string[] = STORYBOARD_ASPECTS.includes(storyboard.aspectRatio as (typeof STORYBOARD_ASPECTS)[number])
    ? [...STORYBOARD_ASPECTS]
    : [storyboard.aspectRatio, ...STORYBOARD_ASPECTS]
  return (
    <MoreMenu width={290}>
      {(menu) => (
        <>
          <MenuHeading>Format</MenuHeading>
          {aspects.map((a) => (
            <MenuRadio
              key={a}
              checked={a === storyboard.aspectRatio}
              onSelect={() => onAspectRatio(a)}
              hint={aspectShape(a)}
            >
              <span className="tabular-nums">{a}</span>
            </MenuRadio>
          ))}
          <p className="px-2.5 pb-1.5 pt-0.5 text-[11px] leading-snug text-muted">
            New images are created in this format.
          </p>
          <MenuDivider />
          <MenuItem
            disabled={converting || storyboard.transitions.length === 0}
            onSelect={onConvert}
            hint="A new sequence with one clip per transition, to keep editing in Sequences. The storyboard stays."
          >
            {converting ? 'Converting to sequence…' : 'Convert to sequence'}
          </MenuItem>
          <LatestExportItem
            ownerId={storyboard.id}
            exporting={exporting}
            untouched="The storyboard stays as it is."
            onEdit={onEditExport}
          />
          <OpenFolderItem target="storyboards" id={storyboard.id} onError={onError} />
          <MarkAllSeenItem ownerId={storyboard.id} what="storyboard" />
          <MenuDivider />
          <MenuItem
            danger
            onSelect={() =>
              menu.confirm({
                question: `Delete “${storyboard.name}”?`,
                note: DELETE_STORYBOARD_TEXT,
                onConfirm: onDelete
              })
            }
          >
            Delete storyboard…
          </MenuItem>
        </>
      )}
    </MoreMenu>
  )
}
