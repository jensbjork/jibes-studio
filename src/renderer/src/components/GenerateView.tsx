import { useEffect, useRef, useState } from 'react'
import { DEFAULT_MODEL, maxReferenceImages } from '@shared/models'
import { NEEDS_CONSENT, type ConsentRequest, type Generation, type GenerationParams } from '@shared/types'
import { ASSET_COPY } from '../lib/assets'
import { getGenerateParams, useGenerateParams } from '../lib/generateStore'
import { ipcErrorMessage, useAssetsState, useModels, useQuote } from '../lib/hooks'
import {
  assetImageIdsFor,
  followAssetImages,
  readRememberedImageIds,
  rememberImageIds,
  withImportedCopies
} from '../lib/library'
import { formatUsd } from '../lib/media'
import type { Intent, Navigate } from '../lib/navigation'
import ConsentDialog from './ConsentDialog'
import GenerationCard from './GenerationCard'
import OpenFolderButton from './library/OpenFolderButton'
import ParamsForm, { missingInput, modelForKind, unavailableModel } from './ParamsForm'
import { addAsset } from './pickers/assetRefs'
import { stableJson } from './sequences/sequenceUtils'

interface Props {
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

export default function GenerateView({ intent, onIntentHandled, navigate }: Props) {
  const { models, error: modelsError } = useModels()
  const [generations, setGenerations] = useState<Generation[]>([])
  // The form lives in an app-level store (remembered across views and restarts; an agent may fill it too).
  const [params, setParams] = useGenerateParams()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  // Non-fatal problems from an intent, e.g. a character without images.
  const [notice, setNotice] = useState<string>()
  // Venice's consent request, with the form it was asked for: accepting it generates exactly that form.
  const [consent, setConsent] = useState<{ request: ConsentRequest; params: GenerationParams }>()
  const [folderError, setFolderError] = useState<string>()

  const model = models.find((m) => m.id === params.model)
  const quote = useQuote(params, model)
  // A wrong @ImageN would send the wrong picture (or none) in a paid generation, so missingInput blocks on it
  // with the words main would refuse it with.
  const missing = missingInput(params) ?? unavailableModel(model)

  useEffect(() => {
    void window.studio.listGenerations().then(setGenerations)
    return window.studio.onGenerationUpdate((g) =>
      setGenerations((list) => {
        const i = list.findIndex((x) => x.id === g.id)
        if (i === -1) return [g, ...list]
        const next = list.slice()
        next[i] = g
        return next
      })
    )
  }, [])

  useEffect(() => {
    if (!folderError) return
    const t = setTimeout(() => setFolderError(undefined), 6000)
    return () => clearTimeout(t)
  }, [folderError])

  // The photos of characters, environments and outfits move when one is renamed (its folder follows the
  // name) or tidied up. The form remembers which library image each of its paths is, and follows the image
  // to its new place.
  const { assets, loaded: assetsLoaded } = useAssetsState()
  const imageIds = useRef<Record<string, string>>(readRememberedImageIds())
  useEffect(() => {
    if (assetsLoaded) setParams((p) => followAssetImages(p, assets, imageIds.current) ?? p)
  }, [assets, assetsLoaded])

  // The store remembers the form itself; this remembers which library image each of its paths is.
  useEffect(() => {
    if (!assetsLoaded) return
    imageIds.current = assetImageIdsFor(params, assets, imageIds.current)
    rememberImageIds(imageIds.current)
  }, [params, assets, assetsLoaded])

  // Intents from the library and prompt views. Tracked by identity so StrictMode's double effect and
  // re-renders don't apply one twice.
  const handledIntent = useRef<Intent>(undefined)
  const modelsReady = models.length > 0 || !!modelsError

  useEffect(() => {
    if (!intent || (intent.type !== 'use-asset' && intent.type !== 'use-prompt')) return
    if (handledIntent.current === intent) return
    // The reference model is chosen from the model list, so wait for it.
    if (intent.type === 'use-asset' && !modelsReady) return
    handledIntent.current = intent
    void applyIntent(intent).finally(onIntentHandled)
  }, [intent, modelsReady])

  async function applyIntent(i: Intent) {
    setError(undefined)
    try {
      if (i.type === 'use-asset') {
        const library = await window.studio.listAssets()
        const asset = library.find((a) => a.id === i.assetId)
        if (!asset) {
          setNotice('Det du valde finns inte längre i biblioteket.')
          return
        }
        // Stay in the current model family when it has a reference variant. An intent is applied
        // asynchronously, so it builds on the form as it is now, not as it was when it arrived.
        const current = getGenerateParams()
        const modelId =
          modelForKind(models, current.model, 'reference-to-video') ?? DEFAULT_MODEL['reference-to-video']
        const max = maxReferenceImages(modelId)
        const byId = new Map(library.map((a) => [a.id, a]))
        const { refs, note } = addAsset(current.referenceImages ?? [], asset, byId, max)
        setParams((p) => ({ ...p, model: modelId, referenceImages: refs }))
        if (!asset.images.length) {
          setNotice(
            `${asset.name} har inga bilder än – lägg till referensfoton under ${ASSET_COPY[asset.kind].plural}.`
          )
        } else setNotice(note && `${asset.name}: ${note}`)
      } else if (i.type === 'use-prompt') {
        const prompt = (await window.studio.listPrompts()).find((p) => p.id === i.promptId)
        if (!prompt) {
          setNotice('Prompten finns inte längre i biblioteket.')
          return
        }
        setParams((p) => ({ ...p, prompt: prompt.body, negativePrompt: prompt.negativePrompt || undefined }))
        setNotice(undefined)
        await window.studio.markPromptUsed(prompt.id)
      }
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  const submit = async () => {
    if (missing || submitting || !model) return
    setSubmitting(true)
    setError(undefined)
    setNotice(undefined)
    const sent = params
    try {
      const g = await window.studio.generate(sent)
      setGenerations((list) => (list.some((x) => x.id === g.id) ? list : [g, ...list]))
      // Outside pictures were copied into Referensbilder; the form uses the copies from now on.
      setParams((p) => withImportedCopies(p, params, g.params) ?? p)
    } catch (e) {
      const message = ipcErrorMessage(e)
      if (message.startsWith(NEEDS_CONSENT)) {
        setConsent({ request: JSON.parse(message.slice(NEEDS_CONSENT.length)) as ConsentRequest, params: sent })
      } else setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const acceptConsent = async () => {
    if (!consent) return
    await window.studio.acceptConsent(consent.request.flow, consent.request.version)
    setConsent(undefined)
    // The form may have changed while the terms were shown (an agent can fill it): then nothing is sent
    // until the user has looked at it and pressed Generera, which shows the price.
    if (stableJson(getGenerateParams()) !== stableJson(consent.params)) {
      setNotice('Formuläret ändrades medan villkoren visades. Kontrollera det och tryck Generera igen.')
      return
    }
    await submit()
  }

  const reuse = (g: Generation) => setParams({ ...g.params })
  const remove = async (g: Generation) => {
    await window.studio.deleteGeneration(g.id)
    setGenerations((list) => list.filter((x) => x.id !== g.id))
  }
  const patch = (g: Generation) => setGenerations((list) => list.map((x) => (x.id === g.id ? g : x)))

  return (
    <div className="flex h-full">
      {consent && (
        <ConsentDialog
          request={consent.request}
          cost={formatUsd(quote)}
          onAccept={acceptConsent}
          onCancel={() => setConsent(undefined)}
        />
      )}
      {/* Form */}
      <section className="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div className="drag h-12 shrink-0" />
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <ParamsForm
            models={models}
            modelsError={modelsError}
            params={params}
            setParams={setParams}
            onSubmit={submit}
            navigate={navigate}
          />
        </div>

        <div className="border-t border-line p-5">
          {notice && (
            <div className="mb-3 flex items-start gap-2 rounded-md bg-accent/10 px-3 py-2 text-[12px] text-accent">
              <span className="min-w-0 flex-1">{notice}</span>
              <button onClick={() => setNotice(undefined)} className="shrink-0 hover:text-text" title="Stäng">
                ✕
              </button>
            </div>
          )}
          {error && <p className="mb-3 max-h-32 overflow-y-auto text-accent select-text">{error}</p>}
          <button
            onClick={submit}
            disabled={!!missing || submitting || !model}
            className="flex w-full items-center justify-between gap-3 rounded-md bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
          >
            <span className="min-w-0 truncate" title={missing}>
              {submitting ? 'Skickar…' : (missing ?? 'Generera')}
            </span>
            <span className="shrink-0 text-white/80">{formatUsd(quote)}</span>
          </button>
          <p className="mt-2 text-center text-[11px] text-muted">⌘ + Enter för att generera</p>
        </div>
      </section>

      {/* Feed */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="drag flex h-12 shrink-0 items-center gap-3 px-6 text-muted">
          <span className="min-w-0 flex-1 truncate">
            {generations.length ? `${generations.length} genereringar` : ''}
          </span>
          {folderError && (
            <span className="no-drag min-w-0 truncate text-[12px] text-accent select-text" title={folderError}>
              {folderError}
            </span>
          )}
          <OpenFolderButton
            target="generations"
            title="Öppna mappen Genereringar i Finder"
            onError={setFolderError}
            className="no-drag rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {generations.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted">
              Dina videor hamnar här. Börja med en prompt till vänster.
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
              {generations.map((g) => (
                <GenerationCard
                  key={g.id}
                  generation={g}
                  model={models.find((m) => m.id === g.model)}
                  onReuse={reuse}
                  onDelete={remove}
                  navigate={navigate}
                  onChange={patch}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
