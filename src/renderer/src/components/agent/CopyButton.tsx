import { useEffect, useState } from 'react'
import { buttonClass } from '../ui/button'

interface Props {
  /** The text, or a function that fetches it when clicked (e.g. the token, read from main on demand). */
  text: string | (() => Promise<string>)
  label?: string
  title?: string
  className?: string
}

const base = `shrink-0 ${buttonClass('secondary', 'sm')}`

/** Copies to the clipboard and says so for a moment. */
export default function CopyButton({ text, label = 'Copy', title, className = base }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(t)
  }, [state])

  const copy = async () => {
    setBusy(true)
    try {
      await navigator.clipboard.writeText(typeof text === 'string' ? text : await text())
      setState('copied')
    } catch {
      // Clipboard access can be denied; the text is selectable anyway.
      setState('failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" onClick={() => void copy()} disabled={busy} title={title} className={className}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : label}
    </button>
  )
}
