import { useState } from 'react'
import type { VideoModel } from '@shared/types'
import type { DirectorEntry } from '../../lib/directors'
import type { Navigate } from '../../lib/navigation'
import { DirectionText } from './DirectionFields'
import DirectionPreview from './DirectionPreview'
import DirectorAvatar from './DirectorAvatar'
import { SectionTitle } from './DirectorEditor'
import { DefaultSettings, ShotSettings } from './DirectorSettings'

interface Props {
  entry: DirectorEntry
  models: VideoModel[]
  navigate: Navigate
  /** "Use a copy": copies it into the library as a director of the user's own and opens that. */
  onUseCopy: () => Promise<void>
}

/**
 * A ready-made director, read-only: what it writes for each part, how it cuts a sequence, its defaults and the
 * Direction section a clip gets. It can direct as it is (Generate, a sequence, a storyboard); "Use a copy" makes one
 * of the user's own to change, add style frames and videos to.
 */
export default function PresetView({ entry, models, navigate, onUseCopy }: Props) {
  const [copying, setCopying] = useState(false)
  const useCopy = async () => {
    setCopying(true)
    try {
      await onUseCopy()
    } finally {
      setCopying(false)
    }
  }
  const { direction } = entry
  return (
    <div className="flex h-full flex-col">
      <div className="drag flex h-12 shrink-0 items-center justify-end px-6">
        <span className="text-[11px] text-muted">Ready-made · read-only</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 pb-16">
          <header className="flex items-center gap-4">
            <DirectorAvatar entry={entry} className="h-14 w-14 rounded-xl text-xl" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-semibold">{entry.name}</h1>
              <p className="mt-0.5 text-muted">{entry.description}</p>
            </div>
          </header>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void useCopy()}
              disabled={copying}
              title="Copies it into your directors, to change it and add style frames and videos"
              className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              {copying ? 'Copying…' : 'Use a copy'}
            </button>
            <button
              onClick={() => navigate('generate', { type: 'use-director', directorId: entry.id })}
              title="Opens Generate directed by it, with its defaults"
              className="rounded-md border border-line px-4 py-2 hover:bg-raised"
            >
              Generate with the director
            </button>
            <span className="text-[11px] text-muted">Ready-made directors can’t be changed – a copy can.</span>
          </div>

          <div className="@container/director mt-8">
            <div className="grid gap-8 @min-[56rem]/director:grid-cols-[minmax(0,1fr)_300px]">
              <div className="@container/fields min-w-0 space-y-9">
                <section>
                  <SectionTitle title="Direction" hint="Written into every prompt it directs, after the references" />
                  <DirectionText direction={direction} />
                  <div className="mt-4 @min-[56rem]/director:hidden">
                    <DirectionPreview entry={entry} />
                  </div>
                </section>
                <section>
                  <SectionTitle title="In a sequence" hint="For new clips only – existing clips aren’t changed" />
                  <ShotSettings shotSeconds={direction.shotSeconds} continuity={direction.continuity} readOnly />
                </section>
                <section>
                  <SectionTitle title="Defaults" hint="Set when you choose the director, where the model offers them" />
                  <DefaultSettings value={direction.defaults} models={models} readOnly />
                </section>
              </div>
              <aside className="sticky top-4 hidden min-w-0 self-start @min-[56rem]/director:block">
                <DirectionPreview entry={entry} />
              </aside>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
