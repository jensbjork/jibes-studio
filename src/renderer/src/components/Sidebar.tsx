import type { ReactNode } from 'react'
import DevBadge from './DevBadge'
import AgentIndicator from './agent/AgentIndicator'
import AssetIcon from './assets/AssetIcon'
import { StoryboardIcon } from './storyboards/icons'
import type { View } from '../lib/navigation'

interface Item {
  id: View
  label: string
  icon: ReactNode
}

const items: Item[] = [
  { id: 'generate', label: 'Generera', icon: '✦' },
  { id: 'characters', label: 'Karaktärer', icon: <AssetIcon kind="character" /> },
  { id: 'environments', label: 'Miljöer', icon: <AssetIcon kind="environment" /> },
  { id: 'outfits', label: 'Kläder', icon: <AssetIcon kind="outfit" /> },
  { id: 'poses', label: 'Poser', icon: <AssetIcon kind="pose" /> },
  { id: 'prompts', label: 'Prompter', icon: '❝' },
  { id: 'sequences', label: 'Sekvenser', icon: '▤' },
  { id: 'storyboards', label: 'Storyboards', icon: <StoryboardIcon /> }
]

interface Props {
  view: View
  onChange: (v: View) => void
  /** Shows a "Dev" badge so the development version can't be mistaken for Studio.app. */
  devProfile?: boolean
  /** The agent activity drawer is open. */
  agentOpen?: boolean
  onToggleAgent: () => void
}

export default function Sidebar({ view, onChange, devProfile = false, agentOpen = false, onToggleAgent }: Props) {
  const button = (item: Item) => {
    const active = item.id === view
    return (
      <button
        key={item.id}
        onClick={() => onChange(item.id)}
        className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition ${
          active ? 'bg-raised text-text' : 'text-muted hover:bg-raised/60 hover:text-text'
        }`}
      >
        <span className="flex w-4 shrink-0 justify-center">{item.icon}</span>
        <span className="flex-1">{item.label}</span>
      </button>
    )
  }

  return (
    <aside className="drag flex w-52 shrink-0 flex-col border-r border-line bg-panel px-3 pb-3 pt-12">
      <div className="mb-4 flex items-center gap-2 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
        Studio
        {devProfile && <DevBadge />}
      </div>
      <nav className="no-drag flex flex-col gap-0.5">{items.map(button)}</nav>
      <div className="no-drag mt-auto flex flex-col gap-0.5">
        <AgentIndicator active={agentOpen} onClick={onToggleAgent} />
        {button({ id: 'settings', label: 'Inställningar', icon: '⚙' })}
      </div>
    </aside>
  )
}
