import { useState } from 'react'
import type { VideoModel } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import { defaultsText, type DirectorEntry } from '../../lib/directors'
import type { Navigate } from '../../lib/navigation'
import SectionTitle from '../library/SectionTitle'
import { buttonClass } from '../ui/button'
import { DirectionText } from './DirectionFields'
import DirectionPreview from './DirectionPreview'
import DirectorAvatar from './DirectorAvatar'
import { modelNamer, shotSettingsText } from './DirectorSettings'

interface Props {
  entry: DirectorEntry
  models: VideoModel[]
  navigate: Navigate
  /** "Copy to edit": copies it into the library as a director of the user's own and opens that. */
  onUseCopy: () => Promise<void>
}

/**
 * A ready-made director, read-only: what it writes for each part, the Direction section a clip gets, and how it cuts a
 * sequence and its defaults, as text. It can direct as it is (Generate, a sequence, a storyboard) – its primary –
 * and "Copy to edit" makes one of the user's own to change, add style frames and videos to. Laid out as an own
 * director's page, so the two read alike; the top bar says it is read-only, in place of the save status.
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
  const shots = shotSettingsText(direction)
  const defaults = defaultsText(direction, modelNamer(models))
  return (
    <div className="flex h-full flex-col">
      <div className="drag flex h-12 shrink-0 items-center justify-end px-6">
        <span className="text-[11px] text-muted">Ready-made · read-only</span>
      </div>
      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-4xl px-8 pb-16">
          <header className="flex items-center gap-4">
            <DirectorAvatar entry={entry} className="h-14 w-14 rounded-xl text-xl" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate py-1 text-xl font-semibold">{entry.name}</h1>
              <p className="mt-0.5 text-muted">{entry.description}</p>
              {/* What a director is, where a first-time user lands (Directors opens on a ready-made one). */}
              <p className="mt-0.5 text-[11px] text-muted">{ASSET_COPY.director.listHint}</p>
            </div>
          </header>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('generate', { type: 'use-director', directorId: entry.id })}
              title="Opens Generate directed by it, with its defaults"
              className={buttonClass('primary')}
            >
              Generate with the director
            </button>
            <button
              type="button"
              onClick={() => void useCopy()}
              disabled={copying}
              title="Copies it into your directors, to change it and add style frames and videos"
              className={buttonClass('secondary')}
            >
              {copying ? 'Copying…' : 'Copy to edit'}
            </button>
          </div>

          <div className="@container/fields mt-8 space-y-9">
            <section>
              <SectionTitle title="Direction" hint="Written into every prompt it directs, after the references" />
              <DirectionText direction={direction} />
              <div className="mt-4">
                <DirectionPreview entry={entry} />
              </div>
            </section>
            {(shots || defaults) && (
              <section>
                <SectionTitle title="Shots and defaults" />
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
                  {shots && (
                    <>
                      <dt className="text-muted" title="For new clips only – existing clips aren’t changed">
                        In a sequence
                      </dt>
                      <dd className="text-text/90">{shots}</dd>
                    </>
                  )}
                  {defaults && (
                    <>
                      <dt className="text-muted" title="Set when you choose the director, where the model offers them">
                        Defaults
                      </dt>
                      <dd className="text-text/90">{defaults}</dd>
                    </>
                  )}
                </dl>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
