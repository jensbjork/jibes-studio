import { useId, type KeyboardEvent } from 'react'
import type { EditorTab } from './EditorContext'
import { useEditor } from './EditorContext'
import { openCard, TabActiveContext } from './cards'
import { focusedWithKeyboard } from './focusOrigin'
import MusicTab from './MusicTab'
import PictureTab from './PictureTab'
import SoundTab from './SoundTab'
import TextTab from './TextTab'
import VoiceTab from './VoiceTab'

// Åtgärder: the operations, grouped in tabs. Each card says what it works on (the whole film or the marked range)
// and, for paid ones, shows the price on its button.

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'bild', label: 'Bild' },
  { id: 'ljud', label: 'Ljud' },
  { id: 'rost', label: 'Röst' },
  { id: 'musik', label: 'Musik & effekter' },
  { id: 'text', label: 'Text' }
]

export default function ActionsPanel({ tab, onTab }: { tab: EditorTab; onTab: (tab: EditorTab) => void }) {
  const { hasApiKey } = useEditor()
  const openTranscribe = () => {
    openCard('rost', 'transcribe')
    onTab('rost')
  }

  const ids = useId()
  // ← → (and Home, End) move between the tabs as in the app's other tablists, while a tab reached with the keyboard
  // has focus (preventDefault, which the workspace's key handler respects). After a click on a tab they stay the
  // player's: a frame back or forward.
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !focusedWithKeyboard(e.target)) return
    e.preventDefault()
    const i = Math.max(0, TABS.findIndex((t) => t.id === tab))
    const n =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? TABS.length - 1
          : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
    onTab(TABS[n].id)
    e.currentTarget.querySelector<HTMLElement>(`[data-tab="${TABS[n].id}"]`)?.focus()
  }

  return (
    <section aria-label="Åtgärder" className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Åtgärder"
        onKeyDown={onTabKeyDown}
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line px-2 pt-1.5"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${ids}-tab-${t.id}`}
            data-tab={t.id}
            aria-selected={tab === t.id}
            aria-controls={`${ids}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => onTab(t.id)}
            // A little tighter in the narrow column (EditWorkspace), so all five tabs still fit.
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-2 py-2 transition @min-[61rem]/main:px-2.5 ${
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
        {!hasApiKey && tab !== 'ljud' && tab !== 'text' && (
          <p className="mx-1.5 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            Lägg till API-nyckeln under Inställningar för att använda AI-åtgärderna. Ljud, klipp och toningar fungerar
            ändå.
          </p>
        )}
        {/* Every tab stays mounted, so a half-written prompt survives a look at another tab. */}
        {TABS.map((t) => (
          <div key={t.id} hidden={tab !== t.id}>
            <TabActiveContext.Provider value={tab === t.id}>
              {t.id === 'bild' && <PictureTab />}
              {t.id === 'ljud' && <SoundTab />}
              {t.id === 'rost' && <VoiceTab />}
              {t.id === 'musik' && <MusicTab />}
              {t.id === 'text' && <TextTab onTranscribe={openTranscribe} />}
            </TabActiveContext.Provider>
          </div>
        ))}
      </div>
    </section>
  )
}
