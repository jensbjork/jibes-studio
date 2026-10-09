import type { KeyboardEvent, RefObject } from 'react'
import type { Generation } from '@shared/types'
import { ScissorsIcon } from '../feed/icons'
import Popover from '../pickers/Popover'
import { formatTakeTime } from '../sequences/sequenceUtils'
import { menuRow, onMenuKeyDown } from '../storyboards/ui'
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
  /** Its prompt differs from the clip's now ("Använd tagningens prompt" is offered only then). */
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
 * open it in Redigera, show it in Finder, and delete it – the last one asked again in the menu itself. A take
 * Redigera keeps (a version, or the film an edit started from) is only taken off the clip, as main does.
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
  const place = owner === 'storyboard' ? 'övergången' : 'klippet'
  const kept = take.keptByEdit === true
  const editorOf = owner === 'storyboard' ? 'övergångens' : 'klippets'
  const removeLabel = kept
    ? owner === 'storyboard'
      ? 'Ta bort från övergången…'
      : 'Ta bort från klippet…'
    : 'Radera tagningen…'
  const label = `Tagningen från ${formatTakeTime(take.createdAt)}`

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
            <p className="mb-1">{kept ? `Ta bort tagningen från ${place}?` : 'Radera tagningen?'}</p>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">
              {kept ? 'Filmen finns kvar i Redigera.' : 'Videofilen flyttas till papperskorgen.'}
              {!kept && active && (
                <span className="mt-1.5 block">
                  {owner === 'storyboard'
                    ? 'Det är den valda tagningen – övergången använder då en annan av sina tagningar.'
                    : 'Det är den valda tagningen – klippet står utan vald tagning tills du väljer en annan.'}
                </span>
              )}
            </p>
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                Avbryt
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  onClose()
                  onDelete()
                }}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover"
              >
                {kept ? 'Ta bort' : 'Radera'}
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
              title={active ? 'Den är redan vald' : playable ? undefined : 'Tagningen kan inte spelas'}
              onClick={() => {
                onClose()
                onPreview()
              }}
              className={menuRow}
            >
              <span className="flex-1">Förhandsvisa utan att välja</span>
              <span className="text-[11px] text-muted">⌥-klick</span>
            </button>
            {onUsePrompt && hasReusablePrompt(take) && (
              <button
                type="button"
                role="menuitem"
                data-menu-item
                disabled={!promptDiffers}
                title={promptDiffers ? `Lägg tagningens prompt i ${editorOf} redigerare` : 'Samma prompt som nu'}
                onClick={() => {
                  onClose()
                  onUsePrompt()
                }}
                className={menuRow}
              >
                Använd tagningens prompt
              </button>
            )}
            {onEdit && playable && (
              <button
                type="button"
                role="menuitem"
                data-menu-item
                title={`Öppna tagningen i Redigera och ändra den med AI. ${
                  owner === 'storyboard' ? 'Övergången' : 'Klippet'
                } rörs inte förrän du skickar tillbaka en version.`}
                onClick={() => {
                  onClose()
                  onEdit()
                }}
                className={menuRow}
              >
                <ScissorsIcon size={13} className="shrink-0 text-muted" />
                Redigera tagningen…
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
                Visa i Finder
              </button>
            )}
            <div className="mx-2 my-1 border-t border-line" />
            <button
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => onView('delete')}
              title={kept ? `Filmen finns kvar i Redigera; den tas bara bort från ${place}.` : undefined}
              className={`${menuRow} text-muted hover:text-accent`}
            >
              {removeLabel}
            </button>
          </div>
        )}
      </div>
    </Popover>
  )
}
