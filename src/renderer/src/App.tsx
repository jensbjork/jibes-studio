import { useCallback, useEffect, useState } from 'react'
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
import Sidebar from './components/Sidebar'
import StoryboardsView from './components/storyboards/StoryboardsView'
import { startAgentFeed } from './lib/agent'
import { useAgentBridge } from './lib/agentBridge'
import { assetKindOfView } from './lib/assets'
import { ipcErrorMessage } from './lib/hooks'
import type { Intent, Navigate, View } from './lib/navigation'

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
  const [agentOpen, setAgentOpen] = useState(false)
  const closeAgent = useCallback(() => setAgentOpen(false), [])

  return (
    <div className="flex h-full">
      <Sidebar
        view={view}
        onChange={(v) => {
          setAgentOpen(false)
          navigate(v)
        }}
        devProfile={settings?.devProfile}
        agentOpen={agentOpen}
        onToggleAgent={() => setAgentOpen((open) => !open)}
      />
      <main className="min-w-0 flex-1">
        {view === 'generate' && <GenerateView intent={intent} onIntentHandled={intentHandled} navigate={navigate} />}
        {/* Keyed so Karaktärer, Miljöer, Kläder and Poser each start with their own selection, search, drafts
            and sound players. */}
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
      <AgentDrawer open={agentOpen} onClose={closeAgent} navigate={navigate} />
      <AgentPresence hidden={agentOpen} onOpen={() => setAgentOpen(true)} />
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
