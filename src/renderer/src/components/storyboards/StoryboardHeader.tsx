import { useEffect, useRef, useState } from 'react'
import type { Storyboard } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatUsd } from '../../lib/media'
import FolderIcon from '../library/FolderIcon'
import Popover from '../pickers/Popover'
import { MoreIcon, PlayIcon } from '../sequences/icons'
import { aspectLabel, formatLength, STORYBOARD_ASPECTS } from './storyboardUtils'
import { menuRow, onMenuKeyDown, primaryButton, secondaryButton } from './ui'

export type ExportState =
  | { status: 'running'; progress: number }
  | { status: 'done'; path: string }
  | { status: 'error'; error: string }

interface Props {
  storyboard: Storyboard
  /** Seconds of the film so far (the selected, finished takes). */
  totalSeconds: number
  /** Transitions with a finished selected take. */
  doneCount: number
  /** Transitions "Generera saknade" would send now. */
  toGenerate: number
  /** Transitions missing a take that already have one on its way. */
  generating: number
  /** Why "Generera saknade" can't start now ("Övergång 1: ruta 1 saknar bild"): it then pays for nothing. */
  runBlocked?: string
  runQuote?: number
  stopping: boolean
  previewDisabled?: string
  exportState?: ExportState
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
  previewDisabled,
  exportState,
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
  onError
}: Props) {
  const count = storyboard.transitions.length
  const exporting = exportState?.status === 'running'
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
        title={`Filmens format: ${aspectLabel(storyboard.aspectRatio)}. Nya bilder skapas i det här formatet.`}
        aria-label="Format"
        className="no-drag shrink-0 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12px] text-muted outline-none transition hover:border-line hover:text-text focus:border-muted"
      >
        {aspects.map((a) => (
          <option key={a} value={a} title={aspectLabel(a)}>
            {a}
          </option>
        ))}
      </select>
      {/* Only on wide windows: the list beside it shows the same, and the actions need the room. */}
      {count > 0 && (
        <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-muted 2xl:inline">
          {doneCount === count ? `${count} klipp` : `${doneCount} av ${count} klipp klara`}
          {totalSeconds > 0 && ` · ${formatLength(totalSeconds)}`}
        </span>
      )}

      <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
        {storyboard.running ? (
          <>
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Skickar saknade…
            </span>
            <button onClick={onStop} disabled={stopping} className={secondaryButton} title="Skickar inga fler klipp">
              {stopping ? 'Stoppar…' : 'Stoppa'}
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
                  ? `${runBlocked}. Inget skickas förrän alla klipp som saknas kan genereras – klicka för att visa.`
                  : toGenerate > 0
                    ? 'Genererar varje klipp som saknas – de är oberoende av varandra och skickas direkt'
                    : generating > 0
                      ? 'Klippen som saknas genereras redan'
                      : 'Alla övergångar har ett färdigt klipp'
              }
            >
              Generera saknade{runReady && ` (${toGenerate})`}
              {runReady && <span className="opacity-75">· {formatUsd(runQuote)}</span>}
            </button>
          )
        )}

        <button onClick={onPreview} disabled={!!previewDisabled} title={previewDisabled ?? 'Spela upp klippen i följd'} className={secondaryButton}>
          <PlayIcon size={11} />
          <span className="hidden xl:inline">Förhandsvisa</span>
        </button>

        {exporting ? (
          <div className="flex w-36 items-center gap-2" title="Exporterar med ffmpeg">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.max(2, exportState.progress * 100)}%` }}
              />
            </div>
            <span className="w-9 text-right text-[12px] tabular-nums text-muted">{Math.round(exportState.progress * 100)} %</span>
          </div>
        ) : (
          <button
            onClick={onExport}
            disabled={!!exportBlocked}
            title={exportBlocked ?? 'Sätter ihop klippen till en mp4-fil'}
            className={exportIsNext ? primaryButton : secondaryButton}
          >
            Exportera
          </button>
        )}

        <MoreMenu
          storyboard={storyboard}
          converting={converting}
          onConvert={onConvert}
          onDelete={onDelete}
          onError={onError}
        />
      </div>
    </div>
  )
}

/** The rarer actions: continue in Sekvenser, the folder in Finder, deleting (asked twice). */
function MoreMenu({
  storyboard,
  converting,
  onConvert,
  onDelete,
  onError
}: {
  storyboard: Storyboard
  converting: boolean
  onConvert: () => void
  onDelete: () => void
  onError: (message: string) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const close = () => {
    setOpen(false)
    setConfirming(false)
  }

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
        aria-label="Fler val"
        title="Fler val"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
      >
        <MoreIcon size={14} />
      </button>
      <Popover anchorRef={anchor} open={open} onClose={close} align="end" width={290} label="Fler val">
        {confirming ? (
          <div className="p-3">
            <p className="mb-1 truncate">Radera ”{storyboard.name}”?</p>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">
              Rutorna och övergångarna försvinner. Klippen finns kvar under Generera, och färdiga filmer ligger kvar i
              mappen. Storyboardens bilder som inget annat använder flyttas till papperskorgen.
            </p>
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                Avbryt
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
                Radera
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
              disabled={converting || storyboard.transitions.length === 0}
              onClick={() => {
                close()
                onConvert()
              }}
              className={`${menuRow} flex-col items-start gap-0.5`}
            >
              <span>{converting ? 'Gör om till sekvens…' : 'Gör om till sekvens'}</span>
              <span className="text-[11px] leading-snug text-muted">
                En ny sekvens med ett klipp per övergång, att fortsätta redigera i Sekvenser. Storyboarden finns kvar.
              </span>
            </button>
            <button type="button" role="menuitem" data-menu-item onClick={() => void reveal()} className={menuRow}>
              <FolderIcon size={13} className="shrink-0 text-muted" />
              Öppna mappen i Finder
            </button>
            <div className="mx-2 my-1 border-t border-line" />
            <button
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => setConfirming(true)}
              className={`${menuRow} text-muted hover:text-accent`}
            >
              Radera storyboarden…
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
      placeholder="Namnlös storyboard"
      title="Byt namn"
      aria-label="Storyboardens namn"
      className="no-drag min-w-0 max-w-sm flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold outline-none transition hover:border-line focus:border-muted focus:bg-raised xl:min-w-28"
    />
  )
}
