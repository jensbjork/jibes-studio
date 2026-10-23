import type { ReactNode } from 'react'

interface Props {
  title: string
  /** One short muted line under the title; anything longer goes in hintTitle. */
  hint?: ReactNode
  /** The hint's tooltip: the rest of the explanation. */
  hintTitle?: string
  /** On the right of the title: ＋ Add, Copy, a warning. */
  actions?: ReactNode
  /** The title names this field (Description): a label pointing at it instead of a heading. */
  htmlFor?: string
}

/**
 * The head of a section in a library editor (Description, Reference images, Voice, Direction …), laid out one way
 * everywhere: the title on the left, its actions on the right, at most one short muted line under it. Longer help goes
 * in that line's tooltip, never a second paragraph.
 */
export default function SectionTitle({ title, hint, hintTitle, actions, htmlFor }: Props) {
  return (
    <div className="mb-3">
      {/* As tall as the actions' buttons, with or without them, so every section starts the same way. */}
      <div className="flex min-h-7 items-center justify-between gap-4">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-medium">
            {title}
          </label>
        ) : (
          <h2 className="font-medium">{title}</h2>
        )}
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {hint && (
        <p title={hintTitle} className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-muted">
          {hint}
        </p>
      )}
    </div>
  )
}

export { SectionTitle }
