import { useMemo, useRef } from 'react'
import type { Settings } from '@shared/types'
import AgentSettingsSection from './agent/AgentSettingsSection'
import LibrarySection from './library/LibrarySection'
import AboutSettings from './settings/AboutSettings'
import GenerationSettings from './settings/GenerationSettings'
import LibraryArchiveSection from './settings/LibraryArchiveSection'
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

// Inställningar: one section per subject, each with a heading, one line on what it is for and then its settings,
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
        attention: settings.hasApiKey ? undefined : 'Ingen API-nyckel än'
      },
      { id: SECTION.generation, label: 'Generering' },
      { id: SECTION.library, label: 'Bibliotek' },
      { id: SECTION.archive, label: 'Export och import' },
      { id: SECTION.agent, label: 'Agentanslutning' },
      { id: SECTION.tools, label: 'Verktyg', attention: ffmpegMissing ? 'ffmpeg saknas' : undefined },
      { id: SECTION.about, label: 'Om Studio' }
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
        <h1 className="pb-6 pt-14 text-xl font-semibold">Inställningar</h1>

        <div className="@4xl/main:flex @4xl/main:items-start @4xl/main:gap-12">
          {/* Beside the sections when there is room… */}
          <nav
            aria-label="Delar av inställningarna"
            className="sticky top-8 hidden w-44 shrink-0 @4xl/main:block"
          >
            <SettingsNav items={items} active={active} onGo={go} layout="side" />
          </nav>
          {/* …and a sticky row above them on a narrow window. */}
          <nav
            aria-label="Delar av inställningarna"
            className="sticky top-0 z-10 -mx-8 mb-8 overflow-x-auto border-b border-line bg-bg/90 px-8 py-2.5 backdrop-blur @4xl/main:hidden"
          >
            <SettingsNav items={items} active={active} onGo={go} layout="top" />
          </nav>

          <div className="min-w-0 flex-1 @4xl/main:max-w-[620px]">
            <SettingsSection
              id={SECTION.venice}
              title="Venice"
              description="Studio genererar video, bilder och ljud via ditt Venice-konto."
            >
              <VeniceSettings hasApiKey={settings.hasApiKey} onChanged={onChanged} />
            </SettingsSection>

            <SettingsSection
              id={SECTION.generation}
              title="Generering"
              description="Hur Studio skriver prompter och skapar bilder."
            >
              <GenerationSettings settings={settings} onChanged={onChanged} />
            </SettingsSection>

            <SettingsSection id={SECTION.library} title="Bibliotek" ownIntro>
              {/* LibrarySection brings its own heading too; this section's is the one shown. */}
              <div className="[&>section]:mb-0 [&>section>h2]:hidden">
                <LibrarySection />
              </div>
            </SettingsSection>

            <SettingsSection id={SECTION.archive} title="Export och import" ownIntro>
              <LibraryArchiveSection />
            </SettingsSection>

            <SettingsSection
              id={SECTION.agent}
              title="Agentanslutning"
              description="Låt dina egna AI-agenter, till exempel OpenClaw eller Hermes Agent, arbeta i Studio via MCP."
            >
              <AgentSettingsSection />
            </SettingsSection>

            <SettingsSection
              id={SECTION.tools}
              title="Verktyg"
              description="Program på den här Macen som Studio använder."
            >
              <ToolsSettings ffmpeg={ffmpeg} />
            </SettingsSection>

            <SettingsSection id={SECTION.about} title="Om Studio" description="Versionen du kör.">
              <AboutSettings devProfile={settings.devProfile} />
            </SettingsSection>
          </div>
        </div>
      </div>
    </div>
  )
}
