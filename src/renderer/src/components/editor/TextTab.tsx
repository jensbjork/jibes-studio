import { useEffect, useRef, useState } from 'react'
import type { TranscriptSegment } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { FILE_MANAGER } from '../../lib/platform'
import { useEditor } from './EditorContext'
import { fileName, formatClock } from './editorUtils'
import { usePlayheadValue } from './playerController'
import { linkButton } from './ui'
import { languageName } from './VoiceTab'

// Text: the transcript, line by line. Click a time to go there; fix a word for free (saved when leaving the line);
// save it as subtitles (.srt).

export default function TextTab({ onTranscribe }: { onTranscribe: () => void }) {
  const { current, transcript, setTranscript, player } = useEditor()
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const [saving, setSaving] = useState(false)
  const playing = usePlayheadValue(
    player,
    (time) => transcript?.segments.find((s) => time >= s.start && time < s.end)?.id
  )
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(undefined), 6000)
    return () => clearTimeout(t)
  }, [saved])

  if (transcript === undefined) return <p className="px-3 py-4 text-muted">Loading the transcript…</p>
  if (!transcript?.segments.length) {
    return (
      <div className="space-y-2 px-3 py-4">
        <p className="leading-relaxed text-muted">
          No transcript yet. Transcribe the film under Voice and the lines end up here with their times – ready to be
          corrected and saved as subtitles.
        </p>
        <button type="button" onClick={onTranscribe} className={linkButton}>
          Go to Transcribe
        </button>
      </div>
    )
  }

  const save = async (segment: TranscriptSegment, text: string) => {
    const next = text.trim()
    if (!next || next === segment.text) return
    setError(undefined)
    try {
      setTranscript(await window.studio.updateTranscript(current.id, [{ segmentId: segment.id, text: next }]))
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  const saveSrt = async () => {
    setSaving(true)
    setError(undefined)
    try {
      const path = await window.studio.saveSubtitles(current.id)
      if (path) setSaved(path)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-3 pb-3">
      <div className="mb-2 flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[12px] text-muted">
          {transcript.segments.length} {transcript.segments.length === 1 ? 'line' : 'lines'}
          {transcript.language && ` · ${languageName(transcript.language)}`}
        </p>
        <button
          type="button"
          onClick={() => void saveSrt()}
          disabled={saving}
          className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] transition hover:bg-raised disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save subtitles (.srt)'}
        </button>
      </div>
      {saved && (
        <p className="mb-2 flex items-center gap-2 text-[11px] text-emerald-300/90">
          Saved: <span className="min-w-0 truncate font-mono">{fileName(saved)}</span>
          <button type="button" onClick={() => window.studio.revealFile(saved)} className={linkButton}>
            Show in {FILE_MANAGER}
          </button>
        </p>
      )}
      {error && <p className="mb-2 text-[11px] text-accent select-text">{error}</p>}
      <ol ref={list} className="space-y-0.5">
        {transcript.segments.map((s) => (
          <Line key={`${s.id}:${s.text}`} segment={s} active={s.id === playing} onSeek={() => player.seek(s.start)} onSave={save} />
        ))}
      </ol>
      <p className="mt-3 text-[11px] leading-relaxed text-muted">Corrections are free and saved when you leave the line.</p>
    </div>
  )
}

function Line({
  segment,
  active,
  onSeek,
  onSave
}: {
  segment: TranscriptSegment
  active: boolean
  onSeek: () => void
  onSave: (segment: TranscriptSegment, text: string) => Promise<void>
}) {
  const [text, setText] = useState(segment.text)
  const cancelled = useRef(false)
  return (
    <li className={`flex items-start gap-2 rounded-md px-1.5 py-1 ${active ? 'bg-raised' : ''}`}>
      <button
        type="button"
        onClick={onSeek}
        title="Go here in the film"
        className="mt-0.5 w-12 shrink-0 rounded text-left text-[11px] tabular-nums text-muted transition hover:text-text"
      >
        {formatClock(segment.start)}
      </button>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false
            return
          }
          void onSave(segment, text)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            cancelled.current = true
            setText(segment.text)
            e.currentTarget.blur()
          }
        }}
        rows={1}
        spellCheck={false}
        aria-label={`The line at ${formatClock(segment.start)}`}
        className="min-w-0 flex-1 resize-none rounded border border-transparent bg-transparent px-1 py-0.5 text-[12px] leading-snug outline-none transition [field-sizing:content] hover:border-line focus:border-muted focus:bg-raised"
      />
      {segment.edited && <span className="mt-1 shrink-0 text-[10px] text-muted" title="Corrected by hand">corrected</span>}
    </li>
  )
}
