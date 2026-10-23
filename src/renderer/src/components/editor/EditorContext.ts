import { createContext, useContext, useEffect, useState } from 'react'
import type {
  AudioCatalog,
  Edit,
  EditRange,
  EditTimeline,
  EditVersion,
  SeparationStatus,
  Transcript,
  VideoModel
} from '@shared/types'
import type { Navigate } from '../../lib/navigation'
import type { PlayerController } from './playerController'
import type { RunOutcome, RunRequest, Runner } from './useEditOps'

// What every part of the open edit's view needs: the edit and its current version, the timeline, the marked range,
// the player, the audio models and the runner. Provided by EditWorkspace.

/**
 * The action tabs: Picture, Sound (with music and effects), Voice, Text. The ids are older than the English names;
 * they are kept, since they are stored ('editor:tab') and key the open cards (cards.ts).
 */
export type EditorTab = 'bild' | 'ljud' | 'rost' | 'text'

export interface EditorContextValue {
  edit: Edit
  /** The version operations work on. */
  current: EditVersion
  timeline?: EditTimeline
  /** undefined while loading, null when the version has none. */
  transcript: Transcript | null | undefined
  setTranscript: (t: Transcript | null) => void
  /** Seconds and frames per second of the current version. */
  duration: number
  fps: number
  /** The marked range ("the selection" in the UI), if any. */
  selection?: EditRange
  setSelection: (range: EditRange | undefined) => void
  player: PlayerController
  audio: { catalog?: AudioCatalog; error?: string; loading: boolean; refresh: () => void }
  separation?: SeparationStatus
  /** Venice's video models (the picture operations' choices). */
  models: VideoModel[]
  modelsError?: string
  hasApiKey: boolean
  runner: Runner
  /** The open card reports the part of the film its operation works on, drawn on the timeline. */
  setOpRange: (range: EditRange | undefined) => void
  showTab: (tab: EditorTab) => void
  navigate: Navigate
}

export const EditorContext = createContext<EditorContextValue | null>(null)

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext)
  if (!value) throw new Error('useEditor outside EditorContext')
  return value
}

/** How long "Sent …" stays under a card's button. */
const SENT_NOTE_MS = 7000

/**
 * A card's run: whether it is running, its error, and a short note once a paid job is on its way. Errors from a
 * paid run (a price that changed, a base that moved on) ask the card's plan to be made again.
 */
export function useCardRun(onReplan?: () => void) {
  const { runner } = useEditor()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()
  const [sent, setSent] = useState<string>()

  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setSent(undefined), SENT_NOTE_MS)
    return () => clearTimeout(t)
  }, [sent])

  const run = async (req: RunRequest): Promise<RunOutcome> => {
    setRunning(true)
    setError(undefined)
    setSent(undefined)
    try {
      const outcome = await runner.run(req)
      if (outcome.error) {
        setError(outcome.error)
        if (req.plan) onReplan?.()
      } else if (outcome.ok && (outcome.result?.jobId || outcome.result?.takeId)) {
        setSent('Sent. It shows at the top of Versions and becomes a new version when it’s done.')
      }
      return outcome
    } finally {
      setRunning(false)
    }
  }

  return { running, error, setError, sent, run }
}
