import { useEffect, useMemo, useState } from 'react'
import type { MediaTab } from '@shared/session'
import type { FinishedWork, Generation } from '@shared/types'
import { useModels } from '../../lib/hooks'
import { useMediaTab } from '../../lib/mediaTab'
import type { Intent, Navigate } from '../../lib/navigation'
import { useFreshGenerationIds, useUnseen } from '../../lib/work'
import ClipFeed from '../feed/ClipFeed'
import { useGenerations } from '../feed/useGenerations'
import OpenFolderButton from '../library/OpenFolderButton'
import { StatusDot } from '../work/StatusMark'
import FilmsTab from './FilmsTab'
import PicturesTab from './PicturesTab'

// Mediabanken: everything made, in three tabs. Videor is the whole clip feed (Generera lists only this session's),
// Bilder every still wherever it belongs, Filmer every exported film. The tab is remembered (lib/mediaTab.ts) and
// read by the agents' get_workspace.

interface Props {
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

/** The tab an open-media intent shows: the one it names, else the one its item lives in. */
function tabOf(intent: Extract<Intent, { type: 'open-media' }>): MediaTab | undefined {
  if (intent.tab) return intent.tab
  if (intent.generationId) return 'videos'
  if (intent.stillId) return 'pictures'
  if (intent.exportId) return 'films'
  return undefined
}

export default function MediaView({ intent, onIntentHandled, navigate }: Props) {
  const [chosen, setTab] = useMediaTab()
  const request = intent?.type === 'open-media' ? intent : undefined
  const requested = request && tabOf(request)
  // The asked-for tab shows at once; the store follows a moment later.
  const tab = requested ?? chosen
  // What the shown tab is asked to open, kept by identity per intent so a re-render doesn't open it twice.
  const source = request?.source
  const generationId = requested === 'videos' ? request?.generationId : undefined
  const stillId = requested === 'pictures' ? request?.stillId : undefined
  const exportId = requested === 'films' ? request?.exportId : undefined
  const openGeneration = useMemo(() => (generationId ? { generationId, source } : undefined), [request])
  const openStill = useMemo(() => (stillId ? { stillId, source } : undefined), [request])
  const openExport = useMemo(() => (exportId ? { exportId, source } : undefined), [request])

  useEffect(() => {
    if (!request) return
    if (requested) setTab(requested)
    // Only a tab to show (or nothing the tab holds): done. An item is opened, and reported handled, by its tab.
    if (!generationId && !stillId && !exportId) onIntentHandled()
  }, [request])

  // Every clip, live; kept here so switching tabs doesn't load them again.
  const feed = useGenerations()
  const { models } = useModels()
  const [folderError, setFolderError] = useState<string>()
  useEffect(() => {
    if (!folderError) return
    const t = setTimeout(() => setFolderError(undefined), 6000)
    return () => clearTimeout(t)
  }, [folderError])

  const tabs = <MediaTabs tab={tab} onTab={setTab} />

  if (tab === 'pictures') {
    return (
      <PicturesTab tabs={tabs} navigate={navigate} openRequest={openStill} onOpenRequestHandled={onIntentHandled} />
    )
  }
  if (tab === 'films') {
    return (
      <FilmsTab tabs={tabs} navigate={navigate} openRequest={openExport} onOpenRequestHandled={onIntentHandled} />
    )
  }
  return (
    <ClipFeed
      feed={feed}
      models={models}
      navigate={navigate}
      mode="library"
      leading={tabs}
      onReuse={(g: Generation) => navigate('generate', { type: 'use-generation', generationId: g.id })}
      reuseTitle="Öppna Generera med klippets inställningar"
      emptyText="Inga klipp än. Det du genererar i Generera, sekvenser och storyboards hamnar här."
      openRequest={openGeneration}
      onOpenRequestHandled={onIntentHandled}
      trailing={
        <>
          {folderError && (
            <span className="no-drag min-w-0 max-w-64 truncate text-[12px] text-accent select-text" title={folderError}>
              {folderError}
            </span>
          )}
          <OpenFolderButton
            target="generations"
            title="Öppna mappen Genereringar i Finder"
            onError={setFolderError}
            compact
            className="no-drag shrink-0 rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
          />
        </>
      }
    />
  )
}

const TABS: { id: MediaTab; label: string; title: string }[] = [
  { id: 'videos', label: 'Videor', title: 'Alla klipp: genererade, egna och redigerade' },
  { id: 'pictures', label: 'Bilder', title: 'Alla bilder: skapade, uppladdade och bildrutor ur klipp' },
  { id: 'films', label: 'Filmer', title: 'Filmer exporterade från sekvenser och storyboards' }
]

function isNewStill(w: FinishedWork): boolean {
  return w.kind === 'still' && w.status === 'completed'
}

function isNewFilm(w: FinishedWork): boolean {
  return w.kind === 'export' && w.status === 'completed'
}

/** Videor, Bilder, Filmer; a tab with something new in it that isn't on screen gets the "new" dot. */
function MediaTabs({ tab, onTab }: { tab: MediaTab; onTab: (tab: MediaTab) => void }) {
  const fresh: Record<MediaTab, boolean> = {
    videos: useFreshGenerationIds().size > 0,
    pictures: useUnseen(isNewStill).length > 0,
    films: useUnseen(isNewFilm).length > 0
  }
  return (
    <div role="tablist" aria-label="Mediabankens flikar" className="no-drag flex shrink-0 items-center gap-1">
      {TABS.map((t) => {
        const dot = fresh[t.id] && tab !== t.id
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            title={dot ? `${t.title} – det finns nytt här` : t.title}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold transition ${
              tab === t.id ? 'text-text' : 'text-muted hover:text-text'
            }`}
          >
            {t.label}
            {dot && <StatusDot />}
          </button>
        )
      })}
    </div>
  )
}
