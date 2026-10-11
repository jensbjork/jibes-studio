import AudioPlayButton from '../pickers/AudioPlayButton'
import { KIND_TONE } from '../pickers/assetKinds'
import { audioLabel, audioLabelParts, windowLabel, type FormAudio } from '../pickers/audioRefs'
import { Thumb } from './TokenMenu'
import { fileName, markKey, type PromptReference } from './promptText'

interface Props {
  references: PromptReference[]
  /** The reference audio clips, listed after the pictures. */
  audios: FormAudio[]
  /** @ImageN numbers the prompt mentions. */
  mentioned: ReadonlySet<number>
  /** @AudioN numbers the prompt mentions. */
  mentionedAudio: ReadonlySet<number>
  /**
   * @ImageN / @AudioN numbers the References legend explains (its description, or who wears an outfit): not marked
   * as unmentioned, since the model is told what they are.
   */
  explained: ReadonlySet<number>
  explainedAudio: ReadonlySet<number>
  /** Show which pictures and clips the prompt doesn't mention (off while the prompt is empty). */
  showUnused: boolean
  maxImages: number
  /** The picture or clip ("image:3", "audio:1") whose tokens are highlighted (hovered here or in the text). */
  highlighted?: string
  onHighlight: (key: string | undefined) => void
  /** Inserts a token ("@Image3", "@Audio1") at the caret. */
  onInsert: (token: string) => void
}

const row = 'flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition hover:bg-raised'

/**
 * The key to the prompt's @ImageN and @AudioN tokens: one row per reference image and per audio clip (with a
 * play button for the part that is sent), with a warning dot on the ones the prompt never mentions and the
 * References legend doesn't explain either ("beskrivs" on those it does). Clicking a row inserts its token at the
 * caret.
 */
export default function ReferenceStrip({
  references,
  audios,
  mentioned,
  mentionedAudio,
  explained,
  explainedAudio,
  showUnused,
  maxImages,
  highlighted,
  onHighlight,
  onInsert
}: Props) {
  if (!references.length && !audios.length) return null
  return (
    <ul
      aria-label="Referenserna i prompten"
      className="mt-2 divide-y divide-line/60 overflow-hidden rounded-md border border-line"
      onMouseLeave={() => onHighlight(undefined)}
    >
      {references.map((r) => {
        const unmentioned = showUnused && r.sent && !mentioned.has(r.index)
        const described = unmentioned && explained.has(r.index)
        const unused = unmentioned && !described
        const tone = r.asset ? KIND_TONE[r.asset.kind] : undefined
        const token = `@Image${r.index}`
        const key = markKey('image', r.index)
        return (
          <li key={`${r.index}:${r.path}`}>
            <button
              // Keeps the focus (and the caret) in the prompt.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(token)}
              onMouseEnter={() => onHighlight(key)}
              onFocus={() => onHighlight(key)}
              onBlur={() => onHighlight(undefined)}
              title={
                !r.sent
                  ? `Skickas inte – modellen tar max ${maxImages} bilder`
                  : unused
                    ? `Nämns inte i prompten – klicka för att infoga ${token} vid markören`
                    : described
                      ? `Beskrivs i referenslistan som läggs till i prompten – klicka för att infoga ${token} vid markören`
                      : `Infoga ${token} vid markören`
              }
              className={`${row} ${highlighted === key ? 'bg-raised' : ''} ${r.sent ? '' : 'opacity-45'}`}
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
              <Status sent={r.sent} unused={unused} described={described} />
            </button>
          </li>
        )
      })}
      {audios.map((a) => {
        const unmentioned = showUnused && a.sent && !mentionedAudio.has(a.index)
        const described = unmentioned && explainedAudio.has(a.index)
        const unused = unmentioned && !described
        const kind = a.source?.asset.kind
        const token = `@Audio${a.index}`
        const key = markKey('audio', a.index)
        const label = audioLabel(a)
        const parts = audioLabelParts(a)
        return (
          <li key={`audio:${a.index}:${a.path}`} className="flex items-center">
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(token)}
              onMouseEnter={() => onHighlight(key)}
              onFocus={() => onHighlight(key)}
              onBlur={() => onHighlight(undefined)}
              title={
                !a.sent
                  ? 'Skickas inte med den här modellen'
                  : unused
                    ? `Nämns inte i prompten – klicka för att infoga ${token} vid markören`
                    : described
                      ? `Beskrivs i referenslistan som läggs till i prompten – klicka för att infoga ${token} vid markören`
                      : `Infoga ${token} vid markören`
              }
              className={`${row} min-w-0 flex-1 ${highlighted === key ? 'bg-raised' : ''} ${a.sent ? '' : 'opacity-45'}`}
            >
              <span className={`w-[52px] shrink-0 font-medium ${kind ? KIND_TONE[kind].text : 'text-text'}`}>{token}</span>
              <span className="min-w-0 flex-1 truncate">
                {parts.name}
                <span className="text-muted">
                  {' '}
                  · {parts.detail} · {windowLabel(a)}
                </span>
              </span>
              <Status sent={a.sent} unused={unused} described={described} />
            </button>
            <span className="shrink-0 pr-2">
              <AudioPlayButton path={a.path} start={a.start} length={a.length} label={label} className="h-5 w-5" />
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Status({ sent, unused, described }: { sent: boolean; unused: boolean; described: boolean }) {
  if (!sent) return <span className="shrink-0 text-accent">skickas inte</span>
  // Not in the prompt's text, but the References legend tells the model what it is.
  if (described) return <span className="shrink-0 text-muted">beskrivs</span>
  if (!unused) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-amber-300">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      nämns inte
    </span>
  )
}
