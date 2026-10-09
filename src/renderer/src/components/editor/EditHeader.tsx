import { useEffect, useRef, useState } from 'react'
import type { Edit, EditVersion } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import FolderIcon from '../library/FolderIcon'
import Popover from '../pickers/Popover'
import { MoreIcon } from '../sequences/icons'
import { menuRow, onMenuKeyDown, secondaryButton, SubView } from '../storyboards/ui'
import { DELETE_EDIT_TEXT, originLabel } from './editorUtils'
import { BackIcon, CameraIcon, ChevronDownIcon } from './icons'
import SendMenu, { type SentTo } from './SendMenu'
import { PruneConfirm, usePrune } from './VersionsPanel'

// The edit's header, in the window's drag bar: back to the list, the name (click to rename), where the film came
// from, Visa i Finder, Skicka till ▾ and the rarer actions under ⋯.

interface Props {
  edit: Edit
  current: EditVersion
  hasTranscript: boolean
  onBack: () => void
  onRename: (name: string) => void
  onSent: (sent: SentTo) => void
  onDeleted: () => void
  onError: (message: string) => void
  onChanged: () => void
  onSubtitlesSaved: (path: string) => void
}

export default function EditHeader({
  edit,
  current,
  hasTranscript,
  onBack,
  onRename,
  onSent,
  onDeleted,
  onError,
  onChanged,
  onSubtitlesSaved
}: Props) {
  const [renaming, setRenaming] = useState(false)
  const sendAnchor = useRef<HTMLButtonElement>(null)
  const [sendOpen, setSendOpen] = useState(false)

  const reveal = async () => {
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
        onClick={onBack}
        title="Alla redigeringar"
        aria-label="Tillbaka till redigeringarna"
        className="no-drag flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted transition hover:bg-raised hover:text-text"
      >
        <BackIcon size={14} />
        <span className="hidden text-[12px] @min-[67rem]/main:inline">Redigeringar</span>
      </button>
      <NameInput name={edit.name} onRename={onRename} focus={renaming} onFocused={() => setRenaming(false)} />
      <span
        title={edit.origin.missing ? 'Filmen redigeringen gjordes från finns inte längre' : undefined}
        className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[11px] text-muted @min-[51rem]/main:flex"
      >
        {edit.origin.kind === 'import' && <CameraIcon size={11} />}
        {originLabel(edit.origin)}
        {edit.origin.missing && ' (borta)'}
      </span>

      <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void reveal()}
          title="Visa redigeringens mapp med versionerna i Finder"
          className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-muted transition hover:bg-raised hover:text-text"
        >
          <FolderIcon size={13} />
          <span className="hidden @min-[67rem]/main:inline">Visa i Finder</span>
        </button>
        <button
          ref={sendAnchor}
          type="button"
          onClick={() => setSendOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={sendOpen}
          title={`Skicka v${current.number} till en sekvens`}
          className={secondaryButton}
        >
          Skicka till
          <ChevronDownIcon size={12} />
        </button>
        <Popover anchorRef={sendAnchor} open={sendOpen} onClose={() => setSendOpen(false)} align="end" width={300} label="Skicka till">
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
        <MoreMenu
          edit={edit}
          current={current}
          hasTranscript={hasTranscript}
          onRename={() => setRenaming(true)}
          onDeleted={onDeleted}
          onError={onError}
          onChanged={onChanged}
          onSubtitlesSaved={onSubtitlesSaved}
        />
      </div>
    </div>
  )
}

function MoreMenu({
  edit,
  current,
  hasTranscript,
  onRename,
  onDeleted,
  onError,
  onChanged,
  onSubtitlesSaved
}: {
  edit: Edit
  current: EditVersion
  hasTranscript: boolean
  onRename: () => void
  onDeleted: () => void
  onError: (message: string) => void
  onChanged: () => void
  onSubtitlesSaved: (path: string) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [view, setView] = useState<'menu' | 'prune' | 'delete'>()
  const [deleting, setDeleting] = useState(false)
  const close = () => setView(undefined)
  const prune = usePrune(
    edit.id,
    (message) => {
      close()
      onError(message)
    },
    () => {
      close()
      onChanged()
    }
  )

  const saveSrt = async () => {
    close()
    try {
      const path = await window.studio.saveSubtitles(current.id)
      if (path) onSubtitlesSaved(path)
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await window.studio.deleteEdit(edit.id)
      close()
      onDeleted()
    } catch (e) {
      close()
      onError(ipcErrorMessage(e))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setView((v) => (v ? undefined : 'menu'))}
        aria-haspopup="menu"
        aria-expanded={!!view}
        aria-label="Fler val"
        title="Fler val"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
      >
        <MoreIcon size={14} />
      </button>
      <Popover anchorRef={anchor} open={!!view} onClose={close} align="end" width={300} label="Fler val">
        {view === 'prune' && prune.found ? (
          <SubView title="Rensa versioner" onBack={() => setView('menu')}>
            <PruneConfirm found={prune.found} busy={prune.busy} onCancel={close} onPrune={() => void prune.prune()} />
          </SubView>
        ) : view === 'delete' ? (
          <div className="p-3">
            <p className="mb-1 truncate">Radera ”{edit.name}”?</p>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">{DELETE_EDIT_TEXT}</p>
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setView('menu')}
                className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                Avbryt
              </button>
              <button
                type="button"
                autoFocus
                disabled={deleting}
                onClick={() => void remove()}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
              >
                {deleting ? 'Raderar…' : 'Radera'}
              </button>
            </div>
          </div>
        ) : (
          <div role="menu" aria-label="Fler val" onKeyDown={onMenuKeyDown} className="p-1">
            <button
              type="button"
              role="menuitem"
              data-menu-item
              autoFocus
              onClick={() => {
                close()
                onRename()
              }}
              className={menuRow}
            >
              Byt namn
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              disabled={!hasTranscript}
              onClick={() => void saveSrt()}
              title={hasTranscript ? undefined : 'Transkribera filmen först (Röst → Transkribera)'}
              className={menuRow}
            >
              Spara undertexter (.srt)
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              disabled={edit.versions.length < 2 || prune.busy}
              onClick={() => void prune.check().then((ok) => ok && setView('prune'))}
              className={menuRow}
            >
              Rensa versioner…
            </button>
            <div className="mx-2 my-1 border-t border-line" />
            <button
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => setView('delete')}
              className={`${menuRow} text-muted hover:text-accent`}
            >
              Radera redigeringen…
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
  focus,
  onFocused
}: {
  name: string
  onRename: (name: string) => void
  focus: boolean
  onFocused: () => void
}) {
  const [value, setValue] = useState(name)
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!focused) setValue(name)
  }, [name, focused])

  useEffect(() => {
    if (!focus) return
    input.current?.focus()
    input.current?.select()
    onFocused()
  }, [focus])

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
      placeholder="Namnlös redigering"
      title="Byt namn"
      aria-label="Redigeringens namn"
      className="no-drag min-w-0 max-w-sm flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold outline-none transition hover:border-line focus:border-muted focus:bg-raised @min-[67rem]/main:min-w-28"
    />
  )
}
