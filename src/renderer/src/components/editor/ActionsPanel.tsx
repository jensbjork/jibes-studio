import { useId } from 'react'
import { NO_API_KEY } from '../../lib/hooks'
import { Banner } from '../ui/Banner'
import { rovingKeyDown } from '../ui/roving'
import type { EditorTab } from './EditorContext'
import { useEditor } from './EditorContext'
import { openCard, TabActiveContext } from './cards'
import PictureTab from './PictureTab'
import SoundTab from './SoundTab'
import TextTab from './TextTab'
import VoiceTab from './VoiceTab'

// Actions: the operations, grouped in four tabs (Picture, Sound with music and effects, Voice, Text). Each card says
// what it works on (the whole film or the marked range) and, for paid ones, shows the price on its button.

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'bild', label: 'Picture' },
  { id: 'ljud', label: 'Sound' },
  { id: 'rost', label: 'Voice' },
  { id: 'text', label: 'Text' }
]
const TAB_IDS = TABS.map((t) => t.id)

export default function ActionsPanel({ tab, onTab }: { tab: EditorTab; onTab: (tab: EditorTab) => void }) {
  const { hasApiKey } = useEditor()
  const openTranscribe = () => {
    openCard('rost', 'transcribe')
    onTab('rost')
  }

  const ids = useId()

  return (
    <section aria-label="Actions" className="flex min-h-0 flex-1 flex-col">
      {/* ← → (Home, End) move between the tabs as in the app's other tablists, while a tab reached with the keyboard
          has focus (preventDefault, which the workspace's key handler respects). After a click on a tab they stay
          the player's: a frame back or forward. */}
      <div
        role="tablist"
        aria-label="Actions"
        onKeyDown={(e) => rovingKeyDown(e, TAB_IDS, tab, onTab, { keyboardOnly: true })}
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line px-2 pt-1.5"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${ids}-tab-${t.id}`}
            data-roving-id={t.id}
            aria-selected={tab === t.id}
            aria-controls={`${ids}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => onTab(t.id)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2 transition ${
              tab === t.id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${ids}-panel`}
        aria-labelledby={`${ids}-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2"
      >
        {/* Not on Sound, whose paid cards (music, effects) say it themselves among its free ones. */}
        {!hasApiKey && tab !== 'ljud' && tab !== 'text' && (
          <Banner tone="warning" className="mx-1.5 mb-2">
            {NO_API_KEY} to use the AI actions. Cuts, fades and the free sound tools work without it.
          </Banner>
        )}
        {/* Every tab stays mounted, so a half-written prompt survives a look at another tab. */}
        {TABS.map((t) => (
          <div key={t.id} hidden={tab !== t.id}>
            <TabActiveContext.Provider value={tab === t.id}>
              {t.id === 'bild' && <PictureTab />}
              {t.id === 'ljud' && <SoundTab />}
              {t.id === 'rost' && <VoiceTab />}
              {t.id === 'text' && <TextTab onTranscribe={openTranscribe} />}
            </TabActiveContext.Provider>
          </div>
        ))}
      </div>
    </section>
  )
}
