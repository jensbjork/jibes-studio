import { useRef, useState } from 'react'
import type { Edit, EditVersion } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { FILE_MANAGER } from '../../lib/platform'
import { GridIcon } from '../feed/icons'
import FolderIcon from '../library/FolderIcon'
import Popover from '../pickers/Popover'
import { buttonClass } from '../ui/button'
import MoreMenu, { MenuDivider, MenuItem } from '../ui/MoreMenu'
import NameInput from '../ui/NameInput'
import { DELETE_EDIT_TEXT, originLabel } from './editorUtils'
import { CameraIcon, ChevronDownIcon } from './icons'
import SendMenu, { type SentTo } from './SendMenu'
import { PruneConfirm, usePrune } from './VersionsPanel'

// The edit's header, in the window's drag bar, laid out like the other document views: "All edits" (the overview),
// the name (click to rename), where the film came from, Send to ▾, and the rarer actions under ⋯ – Rename, Clean up
// versions…, Open folder and Delete…, which asks inside the menu.

interface Props {
  edit: Edit
  current: EditVersion
  /** "All edits": the overview of every edit, in place of this one. */
  onShowAll: () => void
  onRename: (name: string) => void
  onSent: (sent: SentTo) => void
  /** After the question in ⋯; the view lets go of the edit and opens its neighbour. */
  onDelete: () => Promise<void>
  onError: (message: string) => void
  onChanged: () => void
}

export default function EditHeader({ edit, current, onShowAll, onRename, onSent, onDelete, onError, onChanged }: Props) {
  const [renaming, setRenaming] = useState(false)
  const sendAnchor = useRef<HTMLButtonElement>(null)
  const [sendOpen, setSendOpen] = useState(false)
  // "Clean up versions…" counts first, then asks in a popover of its own under ⋯ (it has more to say than a delete),
  // and gives the focus back to ⋯ when it closes.
  const moreAnchor = useRef<HTMLSpanElement>(null)
  const focusMore = () => moreAnchor.current?.querySelector<HTMLElement>('button')?.focus()
  const prune = usePrune(
    edit.id,
    (message) => {
      prune.reset()
      focusMore()
      onError(message)
    },
    () => {
      focusMore()
      onChanged()
    }
  )
  const closePrune = () => {
    prune.reset()
    focusMore()
  }

  const openFolder = async () => {
    try {
      await window.studio.revealLibraryFolder('edits', edit.id)
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  return (
    <div className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line pl-2 pr-3">
      <button
        type="button"
        onClick={onShowAll}
        title="All edits"
        aria-label="All edits"
        className="no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
      >
        <GridIcon size={14} />
      </button>
      <NameInput
        value={edit.name}
        onRename={onRename}
        placeholder="Untitled edit"
        ariaLabel="Edit name"
        autoFocus={renaming}
        onAutoFocused={() => setRenaming(false)}
      />
      <span
        title={edit.origin.missing ? 'The film this edit was made from is gone' : undefined}
        className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[11px] text-muted @min-[51rem]/main:flex"
      >
        {edit.origin.kind === 'import' && <CameraIcon size={11} />}
        {originLabel(edit.origin)}
        {edit.origin.missing && ' (gone)'}
      </span>

      <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
        <button
          ref={sendAnchor}
          type="button"
          onClick={() => setSendOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={sendOpen}
          title={`Send v${current.number} to a sequence`}
          className={buttonClass()}
        >
          Send to
          <ChevronDownIcon size={12} />
        </button>
        <Popover anchorRef={sendAnchor} open={sendOpen} onClose={() => setSendOpen(false)} align="end" width={300} label="Send to">
          {sendOpen && (
            <SendMenu
              versionId={current.id}
              origin={edit.origin}
              onSent={(sent) => {
                setSendOpen(false)
                onSent(sent)
              }}
              onError={(message) => {
                setSendOpen(false)
                onError(message)
              }}
            />
          )}
        </Popover>
        <span ref={moreAnchor} className="flex">
          <MoreMenu>
            {(menu) => (
              <>
                <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
                <MenuItem
                  disabled={edit.versions.length < 2 || prune.busy}
                  onSelect={() => void prune.check()}
                >
                  Clean up versions…
                </MenuItem>
                <MenuItem
                  icon={<FolderIcon size={13} />}
                  title={`Open the folder in ${FILE_MANAGER}`}
                  onSelect={() => void openFolder()}
                >
                  Open folder
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  danger
                  onSelect={() =>
                    menu.confirm({ question: `Delete “${edit.name}”?`, note: DELETE_EDIT_TEXT, onConfirm: onDelete })
                  }
                >
                  Delete…
                </MenuItem>
              </>
            )}
          </MoreMenu>
        </span>
        <Popover anchorRef={moreAnchor} open={!!prune.found} onClose={closePrune} align="end" width={300} label="Clean up versions">
          {prune.found && (
            <PruneConfirm found={prune.found} busy={prune.busy} onCancel={closePrune} onPrune={() => void prune.prune()} />
          )}
        </Popover>
      </div>
    </div>
  )
}
