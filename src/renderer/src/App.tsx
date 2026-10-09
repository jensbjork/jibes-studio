import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import type { LibraryStatus, Settings } from '@shared/types'
import AgentDrawer from './components/agent/AgentDrawer'
import AgentPresence from './components/agent/AgentPresence'
import ApprovalDialog from './components/agent/ApprovalDialog'
import AssetsView from './components/assets/AssetsView'
import EditorView from './components/editor/EditorView'
import GenerateView from './components/GenerateView'
import LibrarySetup from './components/library/LibrarySetup'
import SwitchingOverlay from './components/library/SwitchingOverlay'
import PromptsView from './components/prompts/PromptsView'
import SequencesView from './components/sequences/SequencesView'
import SettingsView from './components/SettingsView'
import Sidebar, { SIDEBAR_WIDTH } from './components/Sidebar'
import StoryboardsView from './components/storyboards/StoryboardsView'
import SeenToast from './components/work/SeenToast'
import WorkPanel from './components/work/WorkPanel'
import WorkStillViewer from './components/work/WorkStillViewer'
import { startAgentFeed } from './lib/agent'
import { useAgentBridge } from './lib/agentBridge'
import { assetKindOfView } from './lib/assets'
import { ipcErrorMessage } from './lib/hooks'
import type { Intent, Navigate, View } from './lib/navigation'
import { startWorkFeed } from './lib/work'

export default function App() {
  const [library, setLibrary] = useState<LibraryStatus>()
  const [libraryError, setLibraryError] = useState<string>()

  const refreshLibrary = async (): Promise<LibraryStatus | undefined> => {
    try {
      const status = await window.studio.libraryStatus()
      setLibrary(status)
      setLibraryError(undefined)
      return status
    } catch (e) {
      setLibraryError(ipcErrorMessage(e))
      return undefined
    }
  }

  useEffect(() => {
    void refreshLibrary()
  }, [])

  // "Studio Dev" (npm run dev) has its own settings and library; mark it everywhere, including the window title
  // shown in Mission Control and the Window menu, so it can't be mistaken for Studio.app.
  const [devProfile, setDevProfile] = useState(false)
  useEffect(() => {
    void window.studio.getSettings().then((s) => {
      setDevProfile(s.devProfile)
      document.title = s.devProfile ? 'Studio Dev' : 'Studio'
    })
  }, [])

  // The folder may vanish while Studio runs (renamed or moved in Finder, a drive unplugged). Main then closes
  // the library; coming back to the window shows the setup screen instead of a workspace that can't load.
  const ready = library?.state === 'ready'
  useEffect(() => {
    if (!ready) return
    const check = (): void => {
      window.studio.libraryStatus().then(
        (status) => {
          if (status.state === 'missing' || status.state === 'unconfigured') setLibrary(status)
        },
        () => {}
      )
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [ready])

  // A switch started before this window loaded: main reloads it when done; asking again covers a switch
  // that failed and went back to the old library, which reloads nothing.
  useEffect(() => {
    if (library?.state !== 'switching') return
    const timer = window.setTimeout(() => void refreshLibrary(), 1000)
    return () => window.clearTimeout(timer)
  }, [library])

  // Everything else reads from the library, so nothing mounts until it is ready.
  if (!library) return <Starting error={libraryError} onRetry={() => void refreshLibrary()} />
  if (library.state === 'switching') return <SwitchingOverlay phase={{ kind: 'waiting' }} />
  if (library.state !== 'ready') return <LibrarySetup status={library} onRetry={refreshLibrary} devProfile={devProfile} />
  return <Workspace />
}

/** Whether the sidebar is the icon rail: per profile (this window's storage), not library data. */
const SIDEBAR_COLLAPSED_KEY = 'sidebar:collapsed:v1'

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** ⌃⌘S, wherever the focus is (text fields too): nothing else in Studio or the default macOS menu uses it. */
function isSidebarShortcut(e: KeyboardEvent): boolean {
  return e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyS' && !e.repeat
}

/** What slides out beside the sidebar; one at a time. */
type Panel = 'agent' | 'work'

function Workspace() {
  const [view, setView] = useState<View>('generate')
  const [intent, setIntent] = useState<Intent>()
  const [settings, setSettings] = useState<Settings | null>(null)

  const refreshSettings = () => window.studio.getSettings().then(setSettings)
  useEffect(() => {
    void refreshSettings()
    // A setting changed elsewhere (safe mode in the image dialog) must not leave Inställningar showing the old one.
    return window.studio.onSettingsChange(() => void refreshSettings())
  }, [])

  // Without a key nothing works, so send first-time users straight to settings.
  useEffect(() => {
    if (settings && !settings.hasApiKey) setView('settings')
  }, [settings?.hasApiKey])

  const navigate: Navigate = (v, i) => {
    setIntent(i)
    setView(v)
  }
  const intentHandled = () => setIntent(undefined)
  const assetKind = assetKindOfView(view)

  // Connected agents (MCP, served by main): live status, activity and approvals for the whole window, and the
  // bridge that lets them read and fill the Generate form. Mounted here, so both work whatever view is open.
  useEffect(() => startAgentFeed(), [])
  useAgentBridge(view, navigate)
  // Pågår och klart: what runs and what is new, for the sidebar, every view and the panel; also installs the
  // playback rule that marks a video seen once it has played.
  useEffect(() => startWorkFeed(), [])

  const [panel, setPanel] = useState<Panel>()
  const closePanel = useCallback(() => setPanel(undefined), [])
  const togglePanel = useCallback((p: Panel) => setPanel((open) => (open === p ? undefined : p)), [])

  // The icon rail: remembered per profile, expanded by default, never collapsed by itself.
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), [])
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // Only a convenience: the sidebar opens expanded next time.
    }
  }, [collapsed])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isSidebarShortcut(e)) return
      e.preventDefault()
      e.stopPropagation()
      setCollapsed((c) => !c)
    }
    // Capture phase on the window: a view's own key handling (Redigera's player keys …) never sees it first.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // The sidebar, the agent drawer, the panel and the toast all place themselves by this width.
  const rootStyle = {
    '--sidebar-w': `${collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded}px`
  } as CSSProperties

  return (
    <div className="flex h-full" style={rootStyle}>
      <Sidebar
        view={view}
        onChange={(v) => {
          setPanel(undefined)
          navigate(v)
        }}
        devProfile={settings?.devProfile}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        panel={panel}
        onTogglePanel={togglePanel}
      />
      {/* A size container: views lay out by the width they get, so collapsing the sidebar gives them room. */}
      <main className="@container/main min-w-0 flex-1">
        {view === 'generate' && <GenerateView intent={intent} onIntentHandled={intentHandled} navigate={navigate} />}
        {/* Keyed so Karaktärer, Miljöer, Produkter, Kläder and Poser each start with their own selection, search,
            drafts and sound players. */}
        {assetKind && (
          <AssetsView
            key={assetKind}
            kind={assetKind}
            intent={intent}
            onIntentHandled={intentHandled}
            navigate={navigate}
          />
        )}
        {view === 'prompts' && <PromptsView navigate={navigate} />}
        {view === 'sequences' && (
          <SequencesView intent={intent} onIntentHandled={intentHandled} navigate={navigate} />
        )}
        {view === 'storyboards' && (
          <StoryboardsView intent={intent} onIntentHandled={intentHandled} navigate={navigate} />
        )}
        {view === 'editor' && <EditorView intent={intent} onIntentHandled={intentHandled} navigate={navigate} />}
        {view === 'settings' && settings && <SettingsView settings={settings} onChanged={refreshSettings} />}
      </main>
      <AgentDrawer open={panel === 'agent'} onClose={closePanel} navigate={navigate} />
      <WorkPanel open={panel === 'work'} onClose={closePanel} navigate={navigate} />
      <WorkStillViewer />
      {/* The pill steps aside while either panel is open: it would cover the panel's bottom at narrow widths. */}
      <AgentPresence hidden={panel !== undefined} onOpen={() => setPanel('agent')} />
      <SeenToast agentPillHidden={panel !== undefined} besideWorkPanel={panel === 'work'} />
      <ApprovalDialog />
    </div>
  )
}

/** Blank window while the library status loads; only shows anything if that fails. */
function Starting({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-12 shrink-0" />
      {error && (
        <div className="flex flex-1 items-center justify-center p-8 pb-20">
          <div className="max-w-sm text-center">
            <h1 className="text-base font-semibold">Studio kunde inte läsa biblioteket</h1>
            <p className="mt-2 leading-relaxed text-muted select-text">{error}</p>
            <button
              onClick={onRetry}
              className="mt-5 rounded-md border border-line px-4 py-2 transition hover:bg-raised"
            >
              Försök igen
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
