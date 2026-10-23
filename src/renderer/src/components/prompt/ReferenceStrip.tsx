import { useId, useState } from 'react'
import { DisclosureChevron } from '../icons'
import AudioPlayButton from '../pickers/AudioPlayButton'
import { videoLabelParts, type FormVideo } from '../pickers/videoRefs'
import VideoWindowPreview from '../pickers/VideoWindowPreview'
import { KIND_TONE, VIDEO_TONE } from '../pickers/assetKinds'
import { audioLabel, audioLabelParts, windowLabel, type FormAudio } from '../pickers/audioRefs'
import { Thumb } from './TokenMenu'
import { fileName, markKey, type PromptReference } from './promptText'

interface Props {
  references: PromptReference[]
  /** The reference audio clips, listed after the pictures. */
  audios: FormAudio[]
  /** The reference videos, listed last. */
  videos?: FormVideo[]
  /** @ImageN numbers the prompt mentions. */
  mentioned: ReadonlySet<number>
  /** @AudioN numbers the prompt mentions. */
  mentionedAudio: ReadonlySet<number>
  /** @VideoN numbers the prompt mentions. */
  mentionedVideo?: ReadonlySet<number>
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
  /**
   * Folded behind "References in the prompt (N)" until opened (remembered): beside the thumbnails and chips, which
   * insert the same tokens, the list is a third copy. Focus mode shows it open, without them.
   */
  collapsible?: boolean
}

const row = 'flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition hover:bg-raised'

/** Remembers whether the folded list was opened (the same everywhere: Generate and the sequence clips). */
const OPEN_KEY = 'prompt:referenceStrip:open:v1'

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function rememberOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    // Then it starts folded next time; harmless.
  }
}

/**
 * The key to the prompt's @ImageN, @AudioN and @VideoN tokens: one row per reference image, per audio clip (with a
 * play button for the part that is sent) and per video (its part plays while the row is hovered), with a warning dot
 * on the ones the prompt never mentions and the References legend doesn't explain either ("described" on those it
 * does). Clicking a row inserts its token at the caret. Collapsible, it folds away and never opens by itself: the issue
 * list under the prompt and the thumbnails' "not sent" already report what isn't mentioned or sent.
 */
export default function ReferenceStrip({
  references,
  audios,
  videos = [],
  mentioned,
  mentionedAudio,
  mentionedVideo,
  explained,
  explainedAudio,
  showUnused,
  maxImages,
  highlighted,
  onHighlight,
  onInsert,
  collapsible = false
}: Props) {
  const [playing, setPlaying] = useState<string>()
  const [open, setOpen] = useState(readOpen)
  const listId = useId()
  const count = references.length + audios.length + videos.length
  if (!count) return null
  const toggle = () => {
    rememberOpen(!open)
    setOpen(!open)
  }
  const shown = !collapsible || open
  return (
    <>
      {collapsible && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={listId}
          className="mt-2 flex items-center gap-1.5 rounded text-[11px] text-muted transition hover:text-text"
        >
          <DisclosureChevron open={open} />
          References in the prompt ({count})
        </button>
      )}
      {shown && (
        <ul
          id={listId}
          aria-label="The references in the prompt"
          className={`${collapsible ? 'mt-1.5' : 'mt-2'} divide-y divide-line/60 overflow-hidden rounded-md border border-line`}
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
                      ? `Not sent – the model takes at most ${maxImages} images`
                      : unused
                        ? `Not mentioned in the prompt – click to insert ${token} at the cursor`
                        : described
                          ? `Described in the reference list added to the prompt – click to insert ${token} at the cursor`
                          : `Insert ${token} at the cursor`
                  }
                  className={`${row} ${highlighted === key ? 'bg-raised' : ''} ${r.sent ? '' : 'opacity-45'}`}
                >
                  <span className={`w-[52px] shrink-0 font-medium ${tone?.text ?? 'text-text'}`}>{token}</span>
                  <Thumb path={r.path} className="h-5 w-5" />
                  <span className="min-w-0 flex-1 truncate">
                    {r.asset ? (
                      <>
                        {r.asset.name}
                        <span className="text-muted"> · photo {r.photo ?? 1}</span>
                      </>
                    ) : (
                      <span className="text-muted">Own image · {fileName(r.path)}</span>
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
                      ? 'Not sent with this model'
                      : unused
                        ? `Not mentioned in the prompt – click to insert ${token} at the cursor`
                        : described
                          ? `Described in the reference list added to the prompt – click to insert ${token} at the cursor`
                          : `Insert ${token} at the cursor`
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
          {videos.map((v) => {
            // Videos aren't described by the legend: unmentioned is unmentioned.
            const unused = showUnused && v.sent && !mentionedVideo?.has(v.index)
            const token = `@Video${v.index}`
            const key = markKey('video', v.index)
            const { name, detail } = videoLabelParts(v)
            return (
              <li key={`video:${v.index}:${v.path}`}>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onInsert(token)}
                  onMouseEnter={() => {
                    onHighlight(key)
                    setPlaying(key)
                  }}
                  onMouseLeave={() => setPlaying((p) => (p === key ? undefined : p))}
                  onFocus={() => onHighlight(key)}
                  onBlur={() => onHighlight(undefined)}
                  title={
                    !v.sent
                      ? 'Not sent with this model'
                      : unused
                        ? `Not mentioned in the prompt – click to insert ${token} at the cursor`
                        : `Insert ${token} at the cursor`
                  }
                  className={`${row} ${highlighted === key ? 'bg-raised' : ''} ${v.sent ? '' : 'opacity-45'}`}
                >
                  <span className={`w-[52px] shrink-0 font-medium ${VIDEO_TONE.text}`}>{token}</span>
                  <span className="relative h-5 w-9 shrink-0 overflow-hidden rounded bg-raised">
                    <VideoWindowPreview path={v.path} start={v.start} length={v.length} playing={playing === key} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {name}
                    <span className="text-muted">
                      {' '}
                      · {detail} · {windowLabel(v)}
                    </span>
                  </span>
                  <Status sent={v.sent} unused={unused} described={false} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function Status({ sent, unused, described }: { sent: boolean; unused: boolean; described: boolean }) {
  if (!sent) return <span className="shrink-0 text-danger">not sent</span>
  // Not in the prompt's text, but the References legend tells the model what it is.
  if (described) return <span className="shrink-0 text-muted">described</span>
  if (!unused) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-warning">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      not mentioned
    </span>
  )
}
