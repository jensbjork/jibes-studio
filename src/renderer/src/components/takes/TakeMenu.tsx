import type { KeyboardEvent, RefObject } from 'react'
import type { Generation } from '@shared/types'
import { FILE_MANAGER, TRASH, shortcut } from '../../lib/platform'
import { ScissorsIcon } from '../feed/icons'
import Popover from '../pickers/Popover'
import { formatTakeTime } from '../sequences/sequenceUtils'
import { buttonClass } from '../ui/button'
import { menuRow, onMenuKeyDown } from '../ui/menu'
import { hasReusablePrompt, isPlayable } from './takeText'

/** Where the strip is: a sequence's clip or a storyboard's transition (the words differ a little). */
export type TakeOwnerKind = 'sequence' | 'storyboard'

export type TakeMenuView = 'menu' | 'delete'

interface Props {
  /** The tile the menu belongs to (focus goes back to it when the menu closes with Esc). */
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  view: TakeMenuView
  take: Generation
  owner: TakeOwnerKind
  /** It is the clip's (or transition's) chosen take. */
  active: boolean
  /** Its prompt differs from the clip's now ("Use the take’s prompt" is offered only then). */
  promptDiffers: boolean
  onView: (view: TakeMenuView) => void
  onClose: () => void
  onPreview: () => void
  onUsePrompt?: () => void
  onEdit?: () => void
  onDelete: () => void
}

/**
 * A take's menu (⋯ on the tile, a right-click, or Shift+F10): preview it without choosing it, bring its prompt back,
 * open it in the Editor, show it in Finder, and delete it – the last one asked again in the menu itself. A take
 * the Editor keeps (a version, or the film an edit started from) is only taken off the clip, as main does.
 */
export default function TakeMenu({
  anchorRef,
  open,
  view,
  take,
  owner,
  active,
  promptDiffers,
  onView,
  onClose,
  onPreview,
  onUsePrompt,
  onEdit,
  onDelete
}: Props) {
  const playable = isPlayable(take)
  const place = owner === 'storyboard' ? 'the transition' : 'the clip'
  const kept = take.keptByEdit === true
  const editorOf = owner === 'storyboard' ? 'the transition’s' : 'the clip’s'
  const removeLabel = kept
    ? owner === 'storyboard'
      ? 'Remove from the transition…'
      : 'Remove from the clip…'
    : 'Delete the take…'
  const label = `The take from ${formatTakeTime(take.createdAt)}`

  // Esc closes the menu only: the transition editor around the strip closes itself on an Esc nobody handled.
  const keepEscape = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') e.preventDefault()
  }

  return (
    <Popover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      align="start"
      width={view === 'menu' ? 260 : 300}
      label={label}
    >
      <div onKeyDown={keepEscape}>
        {view === 'delete' ? (
          <div className="p-3">
            <p className="mb-1">{kept ? `Remove the take from ${place}?` : 'Delete the take?'}</p>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">
              {kept ? 'The film stays in the Editor.' : `The video file goes to ${TRASH}.`}
              {!kept && active && (
                <span className="mt-1.5 block">
                  {owner === 'storyboard'
                    ? 'It’s the selected take – the transition then uses another of its takes.'
                    : 'It’s the selected take – the clip has no selected take until you pick another.'}
                </span>
              )}
            </p>
            {/* Cancel has the focus: the question may have come from a stray ⌫ on the tile. */}
            <div className="flex justify-end gap-1.5">
              <button type="button" autoFocus onClick={onClose} className={buttonClass('ghost', 'sm')}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose()
                  onDelete()
                }}
                className={buttonClass('danger', 'sm')}
              >
                {kept ? 'Remove' : 'Delete'}
              </button>
            </div>
          </div>
        ) : (
          <div role="menu" aria-label={label} onKeyDown={onMenuKeyDown} className="p-1">
            <button
              type="button"
              role="menuitem"
              data-menu-item
              autoFocus
              disabled={!playable || active}
              title={active ? 'It’s already selected' : playable ? undefined : 'The take can’t be played'}
              onClick={() => {
                onClose()
                onPreview()
              }}
              className={menuRow}
            >
              <span className="flex-1">Preview without selecting</span>
              <span className="text-[11px] text-muted">{shortcut('⌥-click')}</span>
            </button>
            {onUsePrompt && hasReusablePrompt(take) && (
              <button
                type="button"
                role="menuitem"
                data-menu-item
                disabled={!promptDiffers}
                title={promptDiffers ? `Put the take’s prompt in ${editorOf} editor` : 'Same prompt as now'}
                onClick={() => {
                  onClose()
                  onUsePrompt()
                }}
                className={menuRow}
              >
                Use the take’s prompt
              </button>
            )}
            {onEdit && playable && (
              <button
                type="button"
                role="menuitem"
                data-menu-item
                title={`Open the take in the Editor and change it with AI. The ${
                  owner === 'storyboard' ? 'transition' : 'clip'
                } isn’t touched until you send a version back.`}
                onClick={() => {
                  onClose()
                  onEdit()
                }}
                className={menuRow}
              >
                <ScissorsIcon size={13} className="shrink-0 text-muted" />
                Edit the take…
              </button>
            )}
            {take.filePath && !take.fileMissing && (
              <button
                type="button"
                role="menuitem"
                data-menu-item
                onClick={() => {
                  onClose()
                  void window.studio.revealFile(take.filePath!)
                }}
                className={menuRow}
              >
                Show in {FILE_MANAGER}
              </button>
            )}
            <div className="mx-2 my-1 border-t border-line" />
            <button
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => onView('delete')}
              title={kept ? `The film stays in the Editor; it’s only removed from ${place}.` : undefined}
              className={`${menuRow} text-muted hover:text-danger focus-visible:text-danger`}
            >
              {removeLabel}
            </button>
          </div>
        )}
      </div>
    </Popover>
  )
}
