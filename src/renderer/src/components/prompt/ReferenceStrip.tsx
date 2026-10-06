import { KIND_TONE } from '../pickers/assetKinds'
import { Thumb } from './TokenMenu'
import { fileName, type PromptReference } from './promptText'

interface Props {
  references: PromptReference[]
  /** @ImageN numbers the prompt mentions. */
  mentioned: ReadonlySet<number>
  /** Show which pictures the prompt doesn't mention (off while the prompt is empty). */
  showUnused: boolean
  maxImages: number
  /** The picture whose tokens are highlighted (hovered here or in the text). */
  highlighted?: number
  onHighlight: (index: number | undefined) => void
  /** Inserts "@ImageN" at the caret. */
  onInsert: (index: number) => void
}

/**
 * The key to the prompt's @ImageN tokens: one row per reference image, with a warning dot on the ones the
 * prompt never mentions. Clicking a row inserts its token at the caret.
 */
export default function ReferenceStrip({
  references,
  mentioned,
  showUnused,
  maxImages,
  highlighted,
  onHighlight,
  onInsert
}: Props) {
  if (!references.length) return null
  return (
    <ul
      aria-label="Referensbilderna i prompten"
      className="mt-2 divide-y divide-line/60 overflow-hidden rounded-md border border-line"
      onMouseLeave={() => onHighlight(undefined)}
    >
      {references.map((r) => {
        const unused = showUnused && r.sent && !mentioned.has(r.index)
        const tone = r.asset ? KIND_TONE[r.asset.kind] : undefined
        const token = `@Image${r.index}`
        return (
          <li key={`${r.index}:${r.path}`}>
            <button
              // Keeps the focus (and the caret) in the prompt.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(r.index)}
              onMouseEnter={() => onHighlight(r.index)}
              onFocus={() => onHighlight(r.index)}
              onBlur={() => onHighlight(undefined)}
              title={
                !r.sent
                  ? `Skickas inte – modellen tar max ${maxImages} bilder`
                  : unused
                    ? `Nämns inte i prompten – klicka för att infoga ${token} vid markören`
                    : `Infoga ${token} vid markören`
              }
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition hover:bg-raised ${
                highlighted === r.index ? 'bg-raised' : ''
              } ${r.sent ? '' : 'opacity-45'}`}
            >
              <span className={`w-[52px] shrink-0 font-medium ${tone?.text ?? 'text-text'}`}>{token}</span>
              <Thumb path={r.path} className="h-5 w-5" />
              <span className="min-w-0 flex-1 truncate">
                {r.asset ? (
                  <>
                    {r.asset.name}
                    <span className="text-muted"> · foto {r.photo ?? 1}</span>
                  </>
                ) : (
                  <span className="text-muted">Egen bild · {fileName(r.path)}</span>
                )}
              </span>
              {!r.sent ? (
                <span className="shrink-0 text-accent">skickas inte</span>
              ) : unused ? (
                <span className="flex shrink-0 items-center gap-1 text-amber-300">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  nämns inte
                </span>
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
