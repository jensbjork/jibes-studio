// Which way each sequence is looked at: the timeline (clips in a row with the editor and takes) or the storyboard
// (panels with start and end images, notes and the sequence's stills). Remembered per sequence in this window's
// storage; a sequence without a remembered choice opens the way the last one was looked at.

export type SequenceViewMode = 'timeline' | 'storyboard'

const MODES_KEY = 'sequences:viewMode:v1'
const LAST_MODE_KEY = 'sequences:lastViewMode:v1'
/** Enough for anyone's sequences; the oldest choices are forgotten first so the entry can't grow forever. */
const MAX_REMEMBERED = 300

function isMode(v: unknown): v is SequenceViewMode {
  return v === 'timeline' || v === 'storyboard'
}

function readModes(): Record<string, SequenceViewMode> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, m]) => isMode(m))) as Record<string, SequenceViewMode>
  } catch {
    return {}
  }
}

/** The mode the most recently viewed sequence was in, for sequences that have none of their own yet. */
export function lastViewMode(): SequenceViewMode {
  try {
    const m = localStorage.getItem(LAST_MODE_KEY)
    return isMode(m) ? m : 'timeline'
  } catch {
    return 'timeline'
  }
}

export function loadViewMode(sequenceId: string): SequenceViewMode {
  return readModes()[sequenceId] ?? lastViewMode()
}

export function saveViewMode(sequenceId: string, mode: SequenceViewMode): void {
  try {
    const modes = readModes()
    // Re-inserted last, so the order of the keys is the order they were last used in.
    delete modes[sequenceId]
    modes[sequenceId] = mode
    const entries = Object.entries(modes)
    localStorage.setItem(MODES_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_REMEMBERED))))
    localStorage.setItem(LAST_MODE_KEY, mode)
  } catch {
    // Remembering the view is only a convenience.
  }
}
