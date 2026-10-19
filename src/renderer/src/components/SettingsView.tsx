import { useMemo, useRef } from 'react'
import type { Settings } from '@shared/types'
import { THIS_COMPUTER } from '../lib/platform'
import AgentSettingsSection from './agent/AgentSettingsSection'
import LibrarySection from './library/LibrarySection'
import AboutSettings from './settings/AboutSettings'
import GenerationSettings from './settings/GenerationSettings'
import LibraryArchiveSection from './settings/LibraryArchiveSection'
import SpendingSettings from './settings/SpendingSettings'
import {
  SETTINGS_SECTION as SECTION,
  SettingsNav,
  SettingsSection,
  useRequestedSection,
  useScrollSpy,
  type SettingsNavItem
} from './settings/SettingsLayout'
import ToolsSettings, { useFfmpegStatus } from './settings/ToolsSettings'
import VeniceSettings from './settings/VeniceSettings'

// Settings: one section per subject, each with a heading, one line on what it is for and then its settings,
// and a navigation that follows the scroll – beside the sections when there is room, as a sticky row of pills above
// them on a narrow window. Every setting does what it did before; only the order and the wording around it changed.

export default function SettingsView({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const ffmpeg = useFfmpegStatus()
  const ffmpegMissing = ffmpeg.status !== undefined && !ffmpeg.status.ok

  const items = useMemo<SettingsNavItem[]>(
    () => [
      {
        id: SECTION.venice,
        label: 'Venice',
        attention: settings.hasApiKey ? undefined : 'No API key yet'
      },
      { id: SECTION.spending, label: 'Spending' },
      { id: SECTION.generation, label: 'Generation' },
      { id: SECTION.library, label: 'Library' },
      { id: SECTION.archive, label: 'Export & import' },
      { id: SECTION.agent, label: 'Agent connection' },
      { id: SECTION.tools, label: 'Tools', attention: ffmpegMissing ? 'ffmpeg is missing' : undefined },
      { id: SECTION.about, label: 'About Studio' }
    ],
    [settings.hasApiKey, ffmpegMissing]
  )
  const ids = useMemo(() => items.map((i) => i.id), [items])
  const { active, go } = useScrollSpy(scroller, ids)
  // Opened at a section from elsewhere (the agent drawer): straight there, without a long smooth scroll.
  useRequestedSection((id) => go(id, true))

  return (
    <div ref={scroller} className="drag h-full overflow-y-auto">
      <div className="no-drag mx-auto w-full max-w-[940px] px-8 pb-24">
        <h1 className="pb-6 pt-14 text-xl font-semibold">Settings</h1>

        <div className="@4xl/main:flex @4xl/main:items-start @4xl/main:gap-12">
          {/* Beside the sections when there is room… */}
          <nav
            aria-label="Settings sections"
            className="sticky top-8 hidden w-44 shrink-0 @4xl/main:block"
          >
            <SettingsNav items={items} active={active} onGo={go} layout="side" />
          </nav>
          {/* …and a sticky row above them on a narrow window. */}
          <nav
            aria-label="Settings sections"
            className="sticky top-0 z-10 -mx-8 mb-8 overflow-x-auto border-b border-line bg-bg/90 px-8 py-2.5 backdrop-blur @4xl/main:hidden"
          >
            <SettingsNav items={items} active={active} onGo={go} layout="top" />
          </nav>

          <div className="min-w-0 flex-1 @4xl/main:max-w-[620px]">
            <SettingsSection
              id={SECTION.venice}
              title="Venice"
              description="Studio generates video, images and sound through your Venice account."
            >
              <VeniceSettings hasApiKey={settings.hasApiKey} onChanged={onChanged} />
            </SettingsSection>

            <SettingsSection
              id={SECTION.spending}
              title="Spending"
              description="What Studio has paid Venice for, and an optional budget it keeps you to."
            >
              <SpendingSettings budget={settings.budget ?? {}} onChanged={onChanged} />
            </SettingsSection>

            <SettingsSection
              id={SECTION.generation}
              title="Generation"
              description="How Studio writes prompts and creates images."
            >
              <GenerationSettings settings={settings} onChanged={onChanged} />
            </SettingsSection>

            <SettingsSection id={SECTION.library} title="Library" ownIntro>
              {/* LibrarySection brings its own heading too; this section's is the one shown. */}
              <div className="[&>section]:mb-0 [&>section>h2]:hidden">
                <LibrarySection />
              </div>
            </SettingsSection>

            <SettingsSection id={SECTION.archive} title="Export & import" ownIntro>
              <LibraryArchiveSection />
            </SettingsSection>

            <SettingsSection
              id={SECTION.agent}
              title="Agent connection"
              description="Let your own AI agents, such as OpenClaw or Hermes Agent, work in Studio through MCP."
            >
              <AgentSettingsSection />
            </SettingsSection>

            <SettingsSection
              id={SECTION.tools}
              title="Tools"
              description={`Programs on ${THIS_COMPUTER} that Studio uses.`}
            >
              <ToolsSettings ffmpeg={ffmpeg} />
            </SettingsSection>

            <SettingsSection id={SECTION.about} title="About Studio" description="The version you are running.">
              <AboutSettings devProfile={settings.devProfile} />
            </SettingsSection>
          </div>
        </div>
      </div>
    </div>
  )
}
