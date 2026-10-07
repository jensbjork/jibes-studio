import { useEffect, useRef, useState } from 'react'
import type { Sequence } from '@shared/types'
import { formatSeconds, formatUsd } from '../../lib/media'
import OpenFolderButton from '../library/OpenFolderButton'
import { PlayIcon } from './icons'

export type ExportState =
  | { status: 'running'; progress: number }
  | { status: 'done'; path: string }
  | { status: 'error'; error: string }

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
  previewDisabled?: string
  exportState?: ExportState
  exportBlocked?: string
  autoFocusName: boolean
  onAutoFocused: () => void
  onRename: (name: string) => void
  onGenerateAll: () => void
  onStop: () => void
  onPreview: () => void
  onExport: () => void
  /** Problems opening the sequence's folder in Finder. */
  onError: (message: string) => void
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
  previewDisabled,
  exportState,
  exportBlocked,
  autoFocusName,
  onAutoFocused,
  onRename,
  onGenerateAll,
  onStop,
  onPreview,
  onExport,
  onError
}: Props) {
  const count = sequence.segments.length
  const exporting = exportState?.status === 'running'
  // The button for the next sensible step gets the accent colour.
  const exportIsNext = toGenerate === 0 && generating === 0 && count > 0

  return (
    <div className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line pl-3 pr-4">
      <NameInput name={sequence.name} onRename={onRename} autoFocus={autoFocusName} onAutoFocused={onAutoFocused} />
      {/* Only on wide windows: the list beside it shows the same, and the actions need the room. */}
      <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-muted 2xl:inline">
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
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Genererar saknade…
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
            <span className="w-9 text-right text-[12px] tabular-nums text-muted">
              {Math.round(exportState.progress * 100)} %
            </span>
          </div>
        ) : (
          <button
            onClick={onExport}
            disabled={!!exportBlocked}
            title={exportBlocked ?? 'Renderar hela sekvensen till en mp4-fil'}
            className={exportIsNext ? primary : secondary}
          >
            Exportera
          </button>
        )}
      </div>
    </div>
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
      className="no-drag min-w-0 max-w-sm flex-1 truncate rounded-md xl:min-w-28 border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold outline-none transition hover:border-line focus:border-muted focus:bg-raised"
    />
  )
}
