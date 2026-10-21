import { useMemo, useRef, useState, type ReactNode } from 'react'
import { ipcErrorMessage, useAssets } from '../../lib/hooks'
import { directorById, directorEntries, directorSummary, type DirectorEntry } from '../../lib/directors'
import AssetIcon from '../assets/AssetIcon'
import { KIND_TONE } from '../pickers/assetKinds'
import Popover from '../pickers/Popover'
import { menuRow, onMenuKeyDown } from '../storyboards/ui'
import DirectorAvatar from './DirectorAvatar'

interface Props {
  /** The sequence's or storyboard's director (an id), undefined for none. */
  directorId: string | undefined
  /** "sequence" / "storyboard": what it directs, for the words. */
  what: string
  /** Under the panel's title: what the director does there and what choosing one changes. */
  intro: string
  /** A line about the clips (or transitions) that choose otherwise; undefined when none does. */
  exceptions?: string
  /** Saves the choice (null: none); rejects with main's refusal, which the panel shows. */
  onChange: (directorId: string | null) => Promise<void>
  /** Opens a director, or (no id) the Directors view. */
  onOpen: (directorId?: string) => void
}

/**
 * "Director" in a sequence's or a storyboard's header, beside Cast and Song: the director of the whole thing (its
 * name on the chip, "+ Director" while there is none) and the panel to choose one – none, the user's own or a
 * ready-made one – with what it changes and the clips that choose otherwise.
 */
export default function DirectorChip({ directorId, what, intro, exceptions, onChange, onOpen }: Props) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const assets = useAssets()
  const current = directorById(directorId, assets)
  const missing = !!directorId && !current

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={current ? `Director: ${current.name}` : missing ? 'Director: no longer exists' : 'Director: none'}
        title={
          current
            ? `Directed by ${current.name}: every ${what === 'storyboard' ? 'transition' : 'clip'} that doesn't choose otherwise`
            : missing
              ? 'The director no longer exists – choose another'
              : `Choose a director for the whole ${what}: editing, look, camera, light …`
        }
        className="flex h-8 max-w-44 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] transition hover:bg-raised"
      >
        <span className={`flex shrink-0 ${current ? KIND_TONE.director.text : 'text-muted'}`}>
          <AssetIcon kind="director" />
        </span>
        {/* Only the clapperboard while the main area is narrow: the header's actions need the room. */}
        <span
          className={`hidden truncate @min-[75rem]/main:inline ${current ? '' : missing ? 'text-accent' : 'text-muted'}`}
        >
          {current ? current.name : missing ? 'Director gone' : '+ Director'}
        </span>
      </button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="end" width={360} maxHeight={560} label="Director">
        {open && (
          <DirectorPanel
            current={current}
            what={what}
            intro={intro}
            exceptions={exceptions}
            assets={assets}
            onChange={async (id) => {
              await onChange(id)
              setOpen(false)
            }}
            onOpen={(id) => {
              setOpen(false)
              onOpen(id)
            }}
          />
        )}
      </Popover>
    </>
  )
}

function DirectorPanel({
  current,
  what,
  intro,
  exceptions,
  assets,
  onChange,
  onOpen
}: {
  current: DirectorEntry | undefined
  what: string
  intro: string
  exceptions?: string
  assets: Parameters<typeof directorEntries>[0]
  onChange: (id: string | null) => Promise<void>
  onOpen: (id?: string) => void
}) {
  const [busy, setBusy] = useState<string | null>()
  const [error, setError] = useState<string>()
  const entries = useMemo(() => directorEntries(assets), [assets])
  const own = entries.filter((e) => !e.preset)
  const presets = entries.filter((e) => e.preset)

  const choose = async (id: string | null) => {
    if ((current?.id ?? null) === id) return
    setBusy(id)
    setError(undefined)
    try {
      await onChange(id)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(undefined)
    }
  }

  const row = (key: string, id: string | null, label: ReactNode, sub: string | undefined, visual: ReactNode) => {
    const checked = (current?.id ?? null) === id
    return (
      <button
        key={key}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        data-menu-item
        autoFocus={checked}
        disabled={busy !== undefined}
        onClick={() => void choose(id)}
        className={`${menuRow} items-start`}
      >
        <span className={`mt-1 w-3 shrink-0 text-accent ${checked ? '' : 'invisible'}`}>✓</span>
        {visual}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{busy === id ? 'Saving…' : label}</span>
          {sub && <span className="block truncate text-[11px] text-muted">{sub}</span>}
        </span>
      </button>
    )
  }

  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <p className="font-medium">Director</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">{intro}</p>
      </div>
      <div role="menu" aria-label="Director" onKeyDown={onMenuKeyDown} className="min-h-0 flex-1 overflow-y-auto p-1">
        {row(
          'none',
          null,
          'None',
          `The ${what}'s prompts are sent as written`,
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-raised text-muted">–</span>
        )}
        {own.length > 0 && <Heading>Yours</Heading>}
        {own.map((e) =>
          row(e.id, e.id, e.name, directorSummary(e), <DirectorAvatar entry={e} className="h-8 w-8 rounded" />)
        )}
        <Heading>Ready-made</Heading>
        {presets.map((e) =>
          row(e.id, e.id, e.name, e.description, <DirectorAvatar entry={e} className="h-8 w-8 rounded" />)
        )}
      </div>
      {exceptions && (
        <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-muted">{exceptions}</p>
      )}
      {error && <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-accent select-text">{error}</p>}
      <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px]">
        {current && (
          <button type="button" onClick={() => onOpen(current.id)} className="text-muted transition hover:text-text hover:underline">
            Open {current.name}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpen()}
          className="ml-auto text-muted transition hover:text-text hover:underline"
        >
          Manage directors →
        </button>
      </div>
    </>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted/80">{children}</p>
  )
}
