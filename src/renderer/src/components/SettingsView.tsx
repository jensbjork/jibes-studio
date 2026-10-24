import { useEffect, useMemo, useRef, useState } from 'react'
import type { Settings } from '@shared/types'
import AgentSettingsSection from './agent/AgentSettingsSection'
import LibrarySection from './library/LibrarySection'
import AboutSettings from './settings/AboutSettings'
import GenerationSettings from './settings/GenerationSettings'
import SpendingSettings from './settings/SpendingSettings'
import {
  SETTINGS_SECTION as SECTION,
  SettingsNav,
  SettingsSection,
  takeRequestedSection,
  useRequestedSection,
  type SettingsNavItem,
  type SettingsSectionId
} from './settings/SettingsLayout'
import { useFfmpegStatus } from './settings/ToolsSettings'
import ServiceSettings from './settings/ServiceSettings'

// Settings: one pane per subject, shown one at a time and chosen in the navigation – beside the pane when there is
// room, as a sticky row of tabs above it on a narrow window. Each pane has a heading, one line on what it is for and
// then its settings. Every pane stays mounted while another is shown, so nothing in one is lost by looking at another.

export default function SettingsView({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const ffmpeg = useFfmpegStatus()
  const ffmpegMissing = ffmpeg.status !== undefined && !ffmpeg.status.ok
  // A pane asked for before Settings opened (⌘K, the Agent panel) is the first one shown: no frame of Service first.
  const [active, setActive] = useState<SettingsSectionId>(() => takeRequestedSection() ?? SECTION.service)

  const items = useMemo<SettingsNavItem[]>(
    () => [
      {
        id: SECTION.service,
        label: 'Service',
        attention: settings.hasApiKey ? undefined : 'No API key yet'
      },
      { id: SECTION.spending, label: 'Spending' },
      { id: SECTION.generation, label: 'Generation' },
      { id: SECTION.library, label: 'Library' },
      { id: SECTION.agent, label: 'Agent connection' },
      { id: SECTION.about, label: 'About', attention: ffmpegMissing ? 'ffmpeg is missing' : undefined }
    ],
    [settings.hasApiKey, ffmpegMissing]
  )

  // Asked for while open: that pane, with keyboard focus on its heading.
  useRequestedSection((id) => {
    setActive(id)
    requestAnimationFrame(() => document.getElementById(`${id}-heading`)?.focus({ preventScroll: true }))
  })

  // Every pane starts at the top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [active])

  const pane = (id: SettingsSectionId) => ({ id, hidden: id !== active })

  return (
    <div ref={scroller} className="drag h-full overflow-y-auto">
      <div className="no-drag mx-auto w-full max-w-[940px] px-8 pb-24">
        <h1 className="pb-6 pt-14 text-xl font-semibold">Settings</h1>

        <div className="@4xl/main:flex @4xl/main:items-start @4xl/main:gap-12">
          {/* Beside the panes when there is room… */}
          <nav aria-label="Settings sections" className="sticky top-8 hidden w-44 shrink-0 @4xl/main:block">
            <SettingsNav items={items} active={active} onGo={setActive} layout="side" />
          </nav>
          {/* …and a sticky row above them on a narrow window. */}
          <nav
            aria-label="Settings sections"
            className="sticky top-0 z-10 -mx-8 mb-8 overflow-x-auto border-b border-line bg-bg/90 px-8 py-2.5 backdrop-blur @4xl/main:hidden"
          >
            <SettingsNav items={items} active={active} onGo={setActive} layout="top" />
          </nav>

          <div className="min-w-0 flex-1 @4xl/main:max-w-[620px]">
            <SettingsSection
              {...pane(SECTION.service)}
              title="Service"
              description="Studio generates video, images and sound through your account at Venice or fal.ai."
            >
              <ServiceSettings settings={settings} onChanged={onChanged} />
            </SettingsSection>

            <SettingsSection
              {...pane(SECTION.spending)}
              title="Spending"
              description="What you’ve spent on generations, and an optional budget."
            >
              <SpendingSettings budget={settings.budget ?? {}} onChanged={onChanged} />
            </SettingsSection>

            <SettingsSection
              {...pane(SECTION.generation)}
              title="Generation"
              description="How Studio writes prompts and creates images."
            >
              <GenerationSettings settings={settings} onChanged={onChanged} />
            </SettingsSection>

            <SettingsSection
              {...pane(SECTION.library)}
              title="Library"
              description="Where everything Studio saves is kept, and how to move it."
            >
              <LibrarySection />
            </SettingsSection>

            <SettingsSection
              {...pane(SECTION.agent)}
              title="Agent connection"
              description="Let your own AI agents, such as Claude Code, Hermes Agent or OpenClaw, work in Studio through MCP."
            >
              <AgentSettingsSection />
            </SettingsSection>

            <SettingsSection
              {...pane(SECTION.about)}
              title="About"
              description="The version, updates and the programs Studio uses."
            >
              <AboutSettings settings={settings} onChanged={onChanged} ffmpeg={ffmpeg} />
            </SettingsSection>
          </div>
        </div>
      </div>
    </div>
  )
}
