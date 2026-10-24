import { useEffect, useRef, useState, type ReactNode } from 'react'
import { buttonClass } from '../ui/button'
import Disclosure from '../ui/Disclosure'
import { rovingKeyDown } from '../ui/roving'

// The building blocks of Settings: a pane per subject (heading, one line on what it is for, then its settings), one
// shown at a time and chosen in the navigation beside it (a row of tabs on a narrow window); a setting inside it
// (name, a short help line, the control); "More about …", the one disclosure of Settings, for what doesn't need to be
// read every time; and the one way a typed setting is saved (SaveActions).

/** The panes' element ids, for the navigation and for opening Settings at one of them. */
export const SETTINGS_SECTION = {
  service: 'settings-service',
  spending: 'settings-spending',
  generation: 'settings-generation',
  library: 'settings-library',
  agent: 'settings-agent',
  about: 'settings-about'
} as const

export type SettingsSectionId = (typeof SETTINGS_SECTION)[keyof typeof SETTINGS_SECTION]

let pendingSection: SettingsSectionId | undefined
const sectionListeners = new Set<(id: SettingsSectionId) => void>()

/**
 * Opens Settings at a pane (the Agent panel's "Agent connection settings →"): call it, then navigate to 'settings'.
 * A view already open shows that pane at once; one about to open starts on it.
 */
export function showSettingsSection(id: SettingsSectionId): void {
  pendingSection = id
  for (const listener of [...sectionListeners]) listener(id)
}

/** For SettingsView as it mounts: the pane asked for before it opened (taken once), so it starts right there. */
export function takeRequestedSection(): SettingsSectionId | undefined {
  const id = pendingSection
  pendingSection = undefined
  return id
}

/** For SettingsView: panes asked for while it is open. */
export function useRequestedSection(onRequest: (id: SettingsSectionId) => void): void {
  const latest = useRef(onRequest)
  latest.current = onRequest
  useEffect(() => {
    const listener = (id: SettingsSectionId): void => {
      pendingSection = undefined
      latest.current(id)
    }
    sectionListeners.add(listener)
    if (pendingSection) listener(pendingSection)
    return () => {
      sectionListeners.delete(listener)
    }
  }, [])
}

export interface SettingsNavItem {
  /** The pane's element id. */
  id: SettingsSectionId
  label: string
  /** Something there needs the user (no API key, ffmpeg missing): an accent dot beside the name. */
  attention?: string
}

/** The id of a pane's tab in one of the two navigations (both are in the page; one is shown). */
function tabId(section: string, layout: 'side' | 'top'): string {
  return `${section}-tab-${layout}`
}

/**
 * One subject of Settings, as a pane: its heading, one line on what it is for, then its settings. Every pane stays
 * mounted while another is shown (`hidden`), so what is going on in one – a check, an unsaved field – survives a
 * look at another.
 */
export function SettingsSection({
  id,
  title,
  description,
  hidden = false,
  children
}: {
  id: SettingsSectionId
  title: string
  description?: ReactNode
  hidden?: boolean
  children: ReactNode
}) {
  const headingId = `${id}-heading`
  return (
    <section id={id} role="tabpanel" aria-labelledby={headingId} hidden={hidden}>
      {/* Focusable, so choosing the pane from elsewhere (⌘K, a panel) lands keyboard focus here. */}
      <h2 id={headingId} tabIndex={-1} className="text-[15px] font-semibold outline-none">
        {title}
      </h2>
      {description && <p className="mt-1 leading-relaxed text-muted">{description}</p>}
      <div className="mt-6 space-y-8">{children}</div>
    </section>
  )
}

/** One setting: its name (with an optional status beside it), a short help line, then the control. */
export function SettingsItem({
  title,
  status,
  help,
  children
}: {
  title?: string
  status?: ReactNode
  help?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      {(title || status) && (
        <div className="flex items-center gap-2.5">
          {title && <h3 className="font-medium">{title}</h3>}
          {status}
        </div>
      )}
      {help && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{help}</p>}
      <div className={title || help ? 'mt-3' : ''}>{children}</div>
    </div>
  )
}

/** A small dot and word beside a setting's name: "● Saved", "● Missing". */
export function StatusPill({ tone, children }: { tone: 'ok' | 'missing' | 'neutral'; children: ReactNode }) {
  const dot = tone === 'ok' ? 'bg-emerald-400' : tone === 'missing' ? 'bg-accent' : 'bg-muted'
  const text = tone === 'ok' ? 'text-success' : tone === 'missing' ? 'text-danger' : 'text-muted'
  return (
    <span className={`flex items-center gap-1.5 text-[11px] ${text}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  )
}

/**
 * "More about …": the longer explanation, closed until asked for – the app's Disclosure at Settings' 12 px. `plain`
 * for a body that holds settings or figures rather than prose (Spending details, Advanced); `open` and `onToggle`
 * when something else may open it.
 */
export function MoreAbout({
  summary,
  children,
  plain,
  open,
  onToggle
}: {
  summary: string
  children: ReactNode
  plain?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
}) {
  return (
    <Disclosure summary={<span className="text-[12px]">{summary}</span>} plain={plain} open={open} onToggle={onToggle}>
      {children}
    </Disclosure>
  )
}

/** How long "Saved" stays beside a field. */
const SAVED_MS = 3000

/**
 * The one way a typed setting (the API key, the budget, the port) is saved: while the field differs from what is
 * saved, a small Save and an Undo (Enter and Esc in the field do the same); after a save, a quiet "Saved" for a moment;
 * a failed save says why in the same place. `status` is 'saved' after a save, or the error.
 */
export function SaveActions({
  dirty,
  saving,
  onSave,
  onRevert,
  status
}: {
  dirty: boolean
  saving: boolean
  onSave: () => void
  onRevert: () => void
  status?: 'saved' | string
}) {
  const [savedShown, setSavedShown] = useState(false)
  useEffect(() => {
    if (dirty || status !== 'saved') return setSavedShown(false)
    setSavedShown(true)
    const t = window.setTimeout(() => setSavedShown(false), SAVED_MS)
    return () => window.clearTimeout(t)
  }, [dirty, status])
  const error = status && status !== 'saved' ? status : undefined

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {dirty && (
        <>
          <button type="button" onClick={onSave} disabled={saving} className={buttonClass('secondary', 'sm')}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onRevert}
            disabled={saving}
            className="text-[12px] text-muted transition hover:text-text disabled:opacity-40"
          >
            Undo
          </button>
        </>
      )}
      {error ? (
        <span role="alert" className="min-w-0 text-[12px] text-danger select-text">
          {error}
        </span>
      ) : (
        <span role="status" className="text-[12px] text-muted">
          {savedShown ? 'Saved' : ''}
        </span>
      )}
    </span>
  )
}

/**
 * The panes' navigation, as tabs: a vertical list beside the panes, or a row of pills above them on a narrow window.
 * One Tab stop; the arrow keys (↑ ↓ in the list, ← → in the row), Home and End move and show.
 */
export function SettingsNav({
  items,
  active,
  onGo,
  layout
}: {
  items: SettingsNavItem[]
  active: SettingsSectionId
  onGo: (id: SettingsSectionId) => void
  layout: 'side' | 'top'
}) {
  const side = layout === 'side'
  const ids = items.map((i) => i.id)
  return (
    <ul
      role="tablist"
      aria-label="Settings"
      aria-orientation={side ? 'vertical' : 'horizontal'}
      onKeyDown={(e) => rovingKeyDown(e, ids, active, onGo, { vertical: side })}
      className={side ? 'flex flex-col gap-0.5' : 'flex gap-1'}
    >
      {items.map((item) => {
        const current = item.id === active
        return (
          <li key={item.id} role="presentation" className="shrink-0">
            <button
              type="button"
              role="tab"
              id={tabId(item.id, layout)}
              aria-selected={current}
              aria-controls={item.id}
              data-roving-id={item.id}
              tabIndex={current ? 0 : -1}
              onClick={() => onGo(item.id)}
              title={item.attention}
              className={`flex items-center gap-2 whitespace-nowrap text-left transition-colors ${
                side ? 'w-full rounded-md px-2.5 py-1.5' : 'rounded-full px-3 py-1 text-[12px]'
              } ${current ? 'bg-raised text-text' : 'text-muted hover:bg-raised/60 hover:text-text'}`}
            >
              <span className={side ? 'min-w-0 flex-1 truncate' : ''}>{item.label}</span>
              {item.attention && (
                <>
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="sr-only">: {item.attention}</span>
                </>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
