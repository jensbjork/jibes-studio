import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CloseIcon } from '../sequences/icons'

// The app's notices, in two places by what they are about: a Banner under the view's header for the state of the
// view (an export that finished, a file that is missing), and a FloatingBanner at the bottom of the work area for
// short-lived feedback from an action. Errors are announced at once (role=alert), everything else politely.

/** The one set of notice colours: border, background and text for each tone. */
export const noticeTones = {
  error: 'border-accent/30 bg-accent/10 text-danger',
  warning: 'border-amber-500/30 bg-amber-500/10 text-warning',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-success',
  info: 'border-line bg-raised text-text'
} as const

export type NoticeTone = keyof typeof noticeTones

/** How long a FloatingBanner stays (not while the pointer is on it); errors stay until closed. */
export const FLOATING_MS = 8000

/** A message across the view (under its header), dismissable when onDismiss is given. */
export function Banner({
  tone,
  children,
  onDismiss,
  className = 'mx-4 mt-3'
}: {
  tone: NoticeTone
  children: ReactNode
  onDismiss?: () => void
  /** Its place: margins by default; Generate puts it above its button with mb-3. */
  className?: string
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex shrink-0 items-start gap-3 rounded-lg border px-3.5 py-2.5 text-[12px] leading-relaxed ${noticeTones[tone]} ${className}`}
    >
      <div className="min-w-0 flex-1 select-text">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close"
          title="Close"
          className="mt-0.5 shrink-0 opacity-60 transition hover:opacity-100"
        >
          <CloseIcon size={11} />
        </button>
      )}
    </div>
  )
}

/**
 * A short-lived notice at the bottom centre of its (relative) container, over the content. With onDismiss it goes
 * by itself after FLOATING_MS, unless it is an error or the pointer is on it; give it a key per notice so a new one
 * starts its own time. `lifted` makes room for the agent's pill at the bottom.
 */
export function FloatingBanner({
  tone,
  children,
  onDismiss,
  lifted
}: {
  tone: NoticeTone
  children: ReactNode
  onDismiss?: () => void
  lifted?: boolean
}) {
  const [held, setHeld] = useState(false)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const timed = tone !== 'error' && !!onDismiss
  useEffect(() => {
    if (!timed || held) return
    const t = setTimeout(() => dismiss.current?.(), FLOATING_MS)
    return () => clearTimeout(t)
  }, [timed, held])
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4 ${lifted ? 'bottom-20' : 'bottom-3'}`}
    >
      {/* Solid underneath: the tones are see-through, and this sits over pictures and text. */}
      <div
        className="pointer-events-auto w-full max-w-xl rounded-lg bg-panel shadow-2xl shadow-black/50"
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
      >
        <Banner tone={tone} onDismiss={onDismiss} className="">
          {children}
        </Banner>
      </div>
    </div>
  )
}
