import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

// The building blocks of Settings: a section per subject (heading, one line on what it is for, then its
// settings), a setting inside it (name, a short help line, the control), "More about …" for what doesn't need to be read
// every time, and the in-page navigation that follows the scroll.

/** The sections' element ids, for the navigation and for opening Settings at one of them. */
export const SETTINGS_SECTION = {
  venice: 'settings-venice',
  spending: 'settings-spending',
  generation: 'settings-generation',
  library: 'settings-library',
  archive: 'settings-archive',
  agent: 'settings-agent',
  tools: 'settings-tools',
  about: 'settings-about'
} as const

export type SettingsSectionId = (typeof SETTINGS_SECTION)[keyof typeof SETTINGS_SECTION]

let pendingSection: SettingsSectionId | undefined
const sectionListeners = new Set<(id: SettingsSectionId) => void>()

/**
 * Opens Settings at a section (the agent drawer's "Agent connection settings →"): call it, then navigate
 * to 'settings'. A view already open scrolls there at once; one about to open does when it mounts.
 */
export function showSettingsSection(id: SettingsSectionId): void {
  pendingSection = id
  for (const listener of [...sectionListeners]) listener(id)
}

/** For SettingsView: the section asked for before it opened (taken once), and later asks while it is open. */
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
  /** The section's element id. */
  id: string
  label: string
  /** Something there needs the user (no API key, ffmpeg missing): an accent dot beside the name. */
  attention?: string
}

/**
 * One subject of Settings: its heading, one line on what it is for, then its settings. `ownIntro`: the content
 * opens with that line itself (a section made elsewhere, like LibrarySection or LibraryArchiveSection), so it starts
 * right under the heading.
 */
export function SettingsSection({
  id,
  title,
  description,
  ownIntro = false,
  children
}: {
  id: string
  title: string
  description?: ReactNode
  ownIntro?: boolean
  children: ReactNode
}) {
  const headingId = `${id}-heading`
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-16 border-t border-line py-10 first:border-t-0 first:pt-0 @4xl/main:scroll-mt-8"
    >
      {/* Focusable, so a jump from the navigation lands keyboard focus here. */}
      <h2 id={headingId} tabIndex={-1} className="text-[15px] font-semibold outline-none">
        {title}
      </h2>
      {description && <p className="mt-1 leading-relaxed text-muted">{description}</p>}
      <div className={ownIntro ? 'mt-1 leading-relaxed' : 'mt-6 space-y-8'}>{children}</div>
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
  const text = tone === 'ok' ? 'text-emerald-300' : tone === 'missing' ? 'text-[#ffb3b5]' : 'text-muted'
  return (
    <span className={`flex items-center gap-1.5 text-[11px] ${text}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  )
}

/** "More about …": the longer explanation, closed until asked for. */
export function MoreAbout({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group text-[12px]">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-muted transition hover:text-text [&::-webkit-details-marker]:hidden">
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          <path
            d="M3.5 2l3 3-3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {summary}
      </summary>
      <div className="mt-2 space-y-2 border-l border-line pl-3.5 leading-relaxed text-muted">{children}</div>
    </details>
  )
}

/** The navigation's link: a vertical list beside the sections, or a row of pills above them on a narrow window. */
export function SettingsNav({
  items,
  active,
  onGo,
  layout
}: {
  items: SettingsNavItem[]
  active: string
  onGo: (id: string) => void
  layout: 'side' | 'top'
}) {
  const side = layout === 'side'
  return (
    <ul className={side ? 'flex flex-col gap-0.5' : 'flex gap-1'}>
      {items.map((item) => {
        const current = item.id === active
        return (
          <li key={item.id} className="shrink-0">
            <button
              type="button"
              onClick={() => onGo(item.id)}
              aria-current={current ? 'location' : undefined}
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

/** How far below the top of the scroll area a section's heading counts as the one being read. */
const READING_LINE_PX = 120
/** A jump from the navigation holds the highlight on its section until the scroll settles (or this long). */
const JUMP_HOLD_MS = 1200

/**
 * Which section is being read in `scroller`: the last one whose heading has passed the reading line, or the last
 * one when the page is scrolled to the end. `go` scrolls a section to the top (smoothly, unless reduced motion is
 * asked for or `instant`), highlights it at once and moves keyboard focus to its heading.
 */
export function useScrollSpy(
  scroller: RefObject<HTMLElement | null>,
  ids: readonly string[]
): { active: string; go: (id: string, instant?: boolean) => void } {
  const [active, setActive] = useState(ids[0] ?? '')
  const holding = useRef(false)
  const holdTimer = useRef<number | undefined>(undefined)
  const key = ids.join('|')

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    // From `key`, so a new array with the same sections doesn't start the effect over.
    const list = key.split('|')
    let frame = 0
    const measure = (): void => {
      frame = 0
      if (holding.current) return
      const line = el.getBoundingClientRect().top + Math.min(READING_LINE_PX, el.clientHeight * 0.3)
      let current = list[0] ?? ''
      for (const id of list) {
        const section = document.getElementById(id)
        if (section && section.getBoundingClientRect().top <= line) current = id
      }
      if (el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) current = list[list.length - 1]
      setActive(current)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const release = (): void => {
      holding.current = false
      window.clearTimeout(holdTimer.current)
    }
    measure()
    el.addEventListener('scroll', schedule, { passive: true })
    el.addEventListener('scrollend', release)
    // Sections grow and shrink (status loaded, "More about" opened): the reading line may pass another heading.
    const resize = new ResizeObserver(schedule)
    resize.observe(el)
    if (el.firstElementChild) resize.observe(el.firstElementChild)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', schedule)
      el.removeEventListener('scrollend', release)
      resize.disconnect()
    }
  }, [scroller, key])

  useEffect(() => () => window.clearTimeout(holdTimer.current), [])

  const go = useCallback((id: string, instant = false) => {
    const section = document.getElementById(id)
    if (!section) return
    setActive(id)
    holding.current = true
    window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      holding.current = false
    }, JUMP_HOLD_MS)
    const reduce = instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }, [])

  return { active, go }
}
