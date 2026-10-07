import type { PromptsTab } from './learning-utils'

const TABS: { id: PromptsTab; label: string; title: string }[] = [
  { id: 'prompts', label: 'Prompter', title: 'Dina sparade prompter' },
  {
    id: 'learnings',
    label: 'Lärdomar',
    title: 'Vad du och agenterna har lärt er om vad som fungerar i prompterna'
  }
]

/** The Prompter view's two halves: the prompt library and the learnings. */
export default function ViewTabs({ tab, onTab }: { tab: PromptsTab; onTab: (tab: PromptsTab) => void }) {
  return (
    <div role="tablist" aria-label="Prompter och lärdomar" className="no-drag flex items-center gap-1">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onTab(t.id)}
          title={t.title}
          className={`rounded-md px-2 py-1 font-semibold transition ${
            tab === t.id ? 'text-text' : 'text-muted hover:text-text'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
