import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ipcErrorMessage } from '../../lib/hooks'
import { buttonClass } from './button'

/** How long an unanswered inline question stays (not while the pointer is on it, it is busy or shows an error). */
export const CONFIRM_MS = 8000

/** A click this soon after arming is the second half of a double-click, not an answer. */
const ARM_MS = 400

interface Props {
  /** The button before it is armed (a ✕, "Delete"). */
  children: ReactNode
  /** Short question shown while armed, e.g. "Delete the clip?". Left out on a tile with no room for it. */
  question?: string
  /** What deleting does, visible beside the question ("The file goes to the Trash."), never only a tooltip. */
  note?: ReactNode
  /** "Delete", or "Remove" when the thing itself survives somewhere else. */
  confirmLabel?: string
  /** Deletes; while a promise runs both buttons wait, and a rejection is shown in place with a way to try again. */
  onConfirm: () => void | Promise<void>
  className?: string
  title?: string
  disabled?: boolean
  /** The armed buttons: sm (in a row, in a line of text) or md (beside other md buttons). */
  size?: 'sm' | 'md'
  /** The armed question's box; the default sits inline where the button was (a tile overlays it instead). */
  armedClassName?: string
}

/**
 * A destructive action with its question in place: the button turns into [question] [note] [Cancel] [Delete].
 * Cancel has the focus (a stray Enter or click deletes nothing), Esc cancels and puts the focus back on the button,
 * and the question goes away by itself after CONFIRM_MS.
 */
export default function ConfirmButton({
  children,
  question,
  note,
  confirmLabel = 'Delete',
  onConfirm,
  className = '',
  title,
  disabled,
  size = 'sm',
  armedClassName = 'inline-flex items-center gap-1.5 whitespace-nowrap'
}: Props) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [held, setHeld] = useState(false)
  const armedAt = useRef(0)
  const box = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // The button gets the focus back once it is there again (the question had it).
  const refocus = useRef(false)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  const disarm = (restoreFocus: boolean): void => {
    if (restoreFocus && box.current?.contains(document.activeElement)) refocus.current = true
    setArmed(false)
    setError(undefined)
    setHeld(false)
  }

  useEffect(() => {
    if (armed || !refocus.current) return
    refocus.current = false
    trigger.current?.focus()
  }, [armed])

  useEffect(() => {
    if (!armed || busy || error || held) return
    const t = setTimeout(() => disarm(true), CONFIRM_MS)
    return () => clearTimeout(t)
  }, [armed, busy, error, held])

  const confirm = (): void => {
    if (busy || Date.now() - armedAt.current < ARM_MS) return
    let result: void | Promise<void>
    try {
      result = onConfirm()
    } catch (e) {
      setError(ipcErrorMessage(e))
      return
    }
    if (!(result instanceof Promise)) {
      disarm(true)
      return
    }
    setBusy(true)
    setError(undefined)
    result.then(
      () => {
        if (!mounted.current) return
        setBusy(false)
        disarm(true)
      },
      (e: unknown) => {
        if (!mounted.current) return
        setBusy(false)
        setError(ipcErrorMessage(e))
      }
    )
  }

  if (!armed) {
    return (
      <button
        ref={trigger}
        type="button"
        title={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          armedAt.current = Date.now()
          setArmed(true)
        }}
        className={className}
      >
        {children}
      </button>
    )
  }

  const buttonSize = size === 'md' ? 'sm' : 'inline'
  const busyLabel = confirmLabel === 'Delete' ? 'Deleting…' : confirmLabel === 'Remove' ? 'Removing…' : `${confirmLabel}…`
  return (
    <span
      ref={box}
      data-confirm
      role="group"
      aria-label={question ?? title ?? confirmLabel}
      className={armedClassName}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || busy) return
        e.preventDefault()
        e.stopPropagation()
        disarm(true)
      }}
    >
      {question && <span className={size === 'md' ? 'text-[12px]' : 'text-[11px] text-muted'}>{question}</span>}
      {note && <span className="text-[11px] text-muted">{note}</span>}
      {error && (
        <span role="alert" className="select-text whitespace-normal break-words text-[11px] text-danger">
          {error}
        </span>
      )}
      <button
        type="button"
        autoFocus
        disabled={busy}
        onClick={() => disarm(true)}
        className={buttonClass('ghost', buttonSize)}
      >
        Cancel
      </button>
      <button type="button" disabled={busy} onClick={confirm} className={buttonClass('danger', buttonSize)}>
        {busy ? busyLabel : error ? 'Try again' : confirmLabel}
      </button>
    </span>
  )
}

export { ConfirmButton }
