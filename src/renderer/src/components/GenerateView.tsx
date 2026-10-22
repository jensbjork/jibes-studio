import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { directorDefaults, resolveDirector, withoutDirection } from '@shared/direction'
import { continuationFrameOf } from '@shared/seams'
import { canUseAgain } from '@shared/generation-label'
import { DEFAULT_MODEL } from '@shared/models'
import { NEEDS_CONSENT, type ConsentRequest, type Generation, type GenerationParams } from '@shared/types'
import { variantsPrice, variantsText } from '@shared/variants'
import { ASSET_COPY } from '../lib/assets'
import { withBudgetConfirm } from '../lib/budget'
import { directedParams, directorOf } from '../lib/directors'
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
import { FILE_MANAGER, shortcut } from '../lib/platform'
import { useVariantCount, withVariants } from '../lib/variants'
import ConsentDialog from './ConsentDialog'
import ClipFeed from './feed/ClipFeed'
import { useGenerations } from './feed/useGenerations'
import OpenFolderButton from './library/OpenFolderButton'
import ParamsForm, { missingInput, modelForKind, unavailableModel } from './ParamsForm'
import { addAssetToForm } from './pickers/assetRefs'
import { stableJson } from './sequences/sequenceUtils'
import VariantPicker from './VariantPicker'

interface Props {
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

export default function GenerateView({ intent, onIntentHandled, navigate }: Props) {
  const { models, error: modelsError } = useModels()
  // Every generation, live (jobs and reviews): the list on the right shows this session's, "Use again" from
  // Media finds any of them.
  const feed = useGenerations()
  // The form lives in an app-level store (remembered across views and restarts; an agent may fill it too).
  const [params, setParams] = useGenerateParams()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  // Non-fatal problems from an intent, e.g. a character without images.
  const [notice, setNotice] = useState<string>()
  // Venice's consent request, with the form it was asked for: accepting it generates exactly that form – as many
  // variants as were asked for, and over the budget if that was confirmed already.
  const [consent, setConsent] = useState<{
    request: ConsentRequest
    params: GenerationParams
    count: number
    overBudgetOk: boolean
  }>()
  const [folderError, setFolderError] = useState<string>()

  const model = models.find((m) => m.id === params.model)
  // The photos of characters, environments and outfits move when one is renamed (its folder follows the
  // name) or tidied up. The form remembers which library image each of its paths is, and follows the image
  // to its new place.
  const { assets, loaded: assetsLoaded } = useAssetsState()
  // What is sent: the form with its director's `avoid`, style frames and videos (main does the same), so the price –
  // style videos raise it – and the checks are those of what Venice gets.
  const sentParams = useMemo(() => directedParams(params, assets), [params, assets])
  const quote = useQuote(sentParams, model)
  // ×1–×4 beside Generate (⌘+Enter sends as many); the button shows what they cost together.
  const [count, setCount] = useVariantCount('generate')
  const total = variantsPrice(quote, count)
  // A wrong @ImageN would send the wrong picture (or none) in a paid generation, so missingInput blocks on it
  // with the words main would refuse it with.
  const missing = missingInput(sentParams) ?? unavailableModel(model)

  useEffect(() => {
    if (!folderError) return
    const t = setTimeout(() => setFolderError(undefined), 6000)
    return () => clearTimeout(t)
  }, [folderError])

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

  // Intents from the library, prompt and Media views. Tracked by identity so StrictMode's double effect and
  // re-renders don't apply one twice.
  const handledIntent = useRef<Intent>(undefined)
  const modelsReady = models.length > 0 || !!modelsError

  useEffect(() => {
    if (
      !intent ||
      (intent.type !== 'use-asset' &&
        intent.type !== 'use-prompt' &&
        intent.type !== 'use-generation' &&
        intent.type !== 'use-director')
    )
      return
    if (handledIntent.current === intent) return
    // The reference model (a director's default model) is chosen from the model list, so wait for it; a clip is
    // looked up in the loaded list.
    if ((intent.type === 'use-asset' || intent.type === 'use-director') && !modelsReady) return
    if (intent.type === 'use-generation' && !feed.loaded) return
    handledIntent.current = intent
    void applyIntent(intent).finally(onIntentHandled)
  }, [intent, modelsReady, feed.loaded])

  async function applyIntent(i: Intent) {
    setError(undefined)
    try {
      if (i.type === 'use-asset') {
        const library = await window.studio.listAssets()
        const asset = library.find((a) => a.id === i.assetId)
        if (!asset) {
          setNotice('What you picked is no longer in the library.')
          return
        }
        // Stay in the current model family when it has a reference variant. An intent is applied
        // asynchronously, so it builds on the form as it is now, not as it was when it arrived.
        const current = getGenerateParams()
        const modelId =
          modelForKind(models, current.model, 'reference-to-video') ?? DEFAULT_MODEL['reference-to-video']
        // Like the pickers: the photos, a character's default outfit and, when the model takes reference audio,
        // the character's first voice clip.
        const { referenceImages, referenceAudios, note } = addAssetToForm(current, asset, library, modelId)
        setParams((p) => ({ ...p, model: modelId, referenceImages, referenceAudios }))
        if (!asset.images.length) {
          setNotice(
            `${asset.name} has no images yet – add reference photos under ${ASSET_COPY[asset.kind].plural}.`
          )
        } else setNotice(note && `${asset.name}: ${note}`)
      } else if (i.type === 'use-director') {
        // "Generate with the director": the form directed by it, with its defaults where the models offer them.
        const director = resolveDirector(i.directorId, await window.studio.listAssets())
        if (!director) {
          setNotice('The director is no longer in the library.')
          return
        }
        const usable = models.filter((m) => !m.offline)
        setParams((p) => {
          const next = { ...p, director: director.id }
          return { ...next, ...directorDefaults(next, director.direction, usable) }
        })
        setNotice(undefined)
      } else if (i.type === 'use-prompt') {
        const prompt = (await window.studio.listPrompts()).find((p) => p.id === i.promptId)
        if (!prompt) {
          setNotice('The prompt is no longer in the library.')
          return
        }
        setParams((p) => ({ ...p, prompt: prompt.body, negativePrompt: prompt.negativePrompt || undefined }))
        setNotice(undefined)
        await window.studio.markPromptUsed(prompt.id)
      } else if (i.type === 'use-generation') {
        // "Use again" in Media: the same as on a card here, for any clip in the library.
        const g = feed.generations.find((x) => x.id === i.generationId)
        if (!g) {
          setNotice('The clip is no longer in the library.')
          return
        }
        if (!canUseAgain(g)) {
          setNotice('This clip’s settings can’t be filled in here: it wasn’t made by Venice from a prompt.')
          return
        }
        reuse(g)
        setNotice(undefined)
      }
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  /** Sends the form: `n` variants (the count chosen), the first comes back and the others arrive as updates. */
  const submit = async (n = count, overBudgetOk = false) => {
    if (missing || submitting || !model) return
    setSubmitting(true)
    setError(undefined)
    setNotice(undefined)
    const sent = params
    let confirmed = overBudgetOk
    try {
      const g = await withBudgetConfirm((yes) => {
        confirmed ||= yes
        return window.studio.generate(sent, { count: n, confirmOverBudget: confirmed })
      })
      // Over the budget, and the user said no: nothing was sent.
      if (!g) return
      feed.upsert(g)
      // Outside pictures were copied into Reference images; the form uses the copies from now on.
      setParams((p) => withImportedCopies(p, params, g.params) ?? p)
    } catch (e) {
      const message = ipcErrorMessage(e)
      if (message.startsWith(NEEDS_CONSENT)) {
        setConsent({
          request: JSON.parse(message.slice(NEEDS_CONSENT.length)) as ConsentRequest,
          params: sent,
          count: n,
          overBudgetOk: confirmed
        })
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
    // until the user has looked at it and pressed Generate, which shows the price.
    if (stableJson(getGenerateParams()) !== stableJson(consent.params)) {
      setNotice('The form changed while the terms were shown. Check it and press Generate again.')
      return
    }
    await submit(consent.count, consent.overBudgetOk)
  }

  // Stable, so the feed's memoized cards don't re-render for it. Only a Venice generation's settings make a form: an
  // own film's or a version's are placeholders, and a take made from a video in the Editor can't be made here.
  const assetsRef = useRef(assets)
  assetsRef.current = assets
  const reuse = useCallback(
    (g: Generation) => {
      if (!canUseAgain(g)) return
      // A take records what was sent, its director's style frames, videos and `avoid` too: the form gets the clip's
      // own, and the director (kept by id) adds them again when it is sent.
      const own = withoutDirection(g.params, directorOf(g.params, assetsRef.current))
      // A sequence clip continued in reference mode carries the previous clip's last frame as its last reference;
      // that frame only meant something in the sequence, so the form gets the clip's own references without it.
      const frame = continuationFrameOf(g.params)
      if (frame?.mode === 'references') {
        setParams({ ...own, referenceImages: (own.referenceImages ?? []).slice(0, -1) })
        return
      }
      setParams({ ...own })
    },
    [setParams]
  )

  return (
    <div className="flex h-full">
      {consent && (
        <ConsentDialog
          request={consent.request}
          cost={
            consent.count > 1
              ? `${variantsText(consent.count)} · ${formatUsd(variantsPrice(quote, consent.count))}`
              : formatUsd(quote)
          }
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
            onSubmit={() => void submit()}
            navigate={navigate}
          />
        </div>

        <div className="border-t border-line p-5">
          {notice && (
            <div className="mb-3 flex items-start gap-2 rounded-md bg-accent/10 px-3 py-2 text-[12px] text-accent">
              <span className="min-w-0 flex-1">{notice}</span>
              <button onClick={() => setNotice(undefined)} className="shrink-0 hover:text-text" title="Close">
                ✕
              </button>
            </div>
          )}
          {error && <p className="mb-3 max-h-32 overflow-y-auto text-accent select-text">{error}</p>}
          <div className="flex items-stretch gap-2">
            <VariantPicker count={count} onChange={setCount} each={quote} />
            <button
              onClick={() => void submit()}
              disabled={!!missing || submitting || !model}
              className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              <span className="min-w-0 truncate" title={missing}>
                {submitting ? 'Sending…' : (missing ?? withVariants('Generate', count))}
              </span>
              <span className="shrink-0 text-white/80">{formatUsd(total)}</span>
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted">
            {shortcut('⌘ + Enter')} to generate{count > 1 ? ` ${variantsText(count)}` : ''}
          </p>
        </div>
      </section>

      {/* This session's clips; everything older is in Media. */}
      <section className="flex min-w-0 flex-1 flex-col">
        <ClipFeed
          feed={feed}
          models={models}
          navigate={navigate}
          mode="session"
          onReuse={reuse}
          emptyText="What you generate now lands here. Everything you made before is in Media."
          openRequest={intent?.type === 'open-generation' ? intent : undefined}
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
                title={`Open the folder “Generations” in ${FILE_MANAGER}`}
                onError={setFolderError}
                compact
                className="no-drag shrink-0 rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
              />
            </>
          }
        />
      </section>
    </div>
  )
}
