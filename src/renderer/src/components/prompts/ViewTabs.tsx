import Tabs, { type TabItem } from '../ui/Tabs'
import type { PromptsTab } from './learning-utils'

const TABS: TabItem<PromptsTab>[] = [
  { id: 'prompts', label: 'Prompts', title: 'Your saved prompts' },
  {
    id: 'learnings',
    label: 'Learnings',
    title: 'What you and the agents have learned about what works in prompts'
  }
]

/**
 * The Prompts view's two halves, the prompt library and the learnings, as the title of the list's header: the first
 * tab's label lines up with a side list's title, in the same weight. ← → switch, as in every tab row.
 */
export default function ViewTabs({ tab, onTab }: { tab: PromptsTab; onTab: (tab: PromptsTab) => void }) {
  return (
    <div className="-ml-2 min-w-0 [&_[role=tab]]:font-medium">
      <Tabs tabs={TABS} value={tab} onChange={onTab} ariaLabel="Prompts and learnings" />
    </div>
  )
}
