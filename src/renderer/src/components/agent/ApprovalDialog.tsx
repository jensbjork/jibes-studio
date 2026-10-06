import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { KINDS, kindOfModelId, paramsForSubmit } from '@shared/models'
import type {
  ApprovalRequest,
  Asset,
  ConsentRequest,
  GenerationParams,
  Segment,
  Sequence,
  VideoModel
} from '@shared/types'
import {
  APPROVAL_TTL_MS,
  approvalQueue,
  deferApproval,
  resolveApproval,
  useAgentState
} from '../../lib/agent'
import { ipcErrorMessage, useAssets, useModels } from '../../lib/hooks'
import { formatUsd, mediaUrl } from '../../lib/media'
import { blockingPromptIssue, promptIssuesOf } from '../../lib/promptIssues'
import ConsentDialog from '../ConsentDialog'
import { KIND_TONE } from '../pickers/assetKinds'
import Modal from '../pickers/Modal'
import { effectiveParams, needsTake, parseConsent, pendingTake } from '../sequences/sequenceUtils'
import { approvalOutcome, approvalTitle, expiresText } from './agentText'
import PromptText, { type TokenTarget } from './PromptText'

/**
 * Paid generations an agent asks for wait here for the user's OK. Shown above every view; several requests
 * queue up and are shown one at a time. Nothing is sent to Venice until "Godkänn och generera".
 */
export default function ApprovalDialog() {
  const agent = useAgentState()
  const queue = approvalQueue(agent)
  // The request on screen stays there until the user acts on it (approves, declines, closes or puts it off),
  // also when it is sent, fails, lapses or is replaced by a newer one meanwhile: the dialog never swaps in
  // another request under their cursor. A replaced one says so, and they move on to the next themselves.
  const [shownId, setShownId] = useState<string>()
  const shown = shownId ? agent.approvals.find((a) => a.id === shownId) : undefined
  // Opening a request from the activity drawer is the user's own choice, so that one may take the screen.
  const focused = agent.focused ? queue.find((a) => a.id === agent.focused) : undefined
  const current = (focused && focused.id !== shownId ? focused : undefined) ?? shown ?? queue[0]
  const currentId = current?.id
  useEffect(() => {
    if (currentId && currentId !== shownId) setShownId(currentId)
  }, [currentId, shownId])
  if (!current) return null
  const id = current.id
  const index = queue.findIndex((a) => a.id === id)
  return (
    <ApprovalPanel
      key={id}
      approval={current}
      position={index === -1 ? undefined : { index: index + 1, total: queue.length }}
      othersWaiting={queue.some((a) => a.id !== id)}
      // Releasing only ever releases this request, so a reply that arrives late can't free the next one.
      hold={(on) => setShownId((cur) => (on ? id : cur === id ? undefined : cur))}
    />
  )
}

type Phase = 'review' | 'declining' | 'submitting' | 'failed'

interface PanelProps {
  approval: ApprovalRequest
  position?: { index: number; total: number }
  /** Other requests are waiting after this one. */
  othersWaiting: boolean
  /** Keeps this request on screen (true) or lets the dialog move on (false). */
  hold: (on: boolean) => void
}

/**
 * How long a request has to be on screen, unchanged, before it can be approved. A click meant for what was
 * there a moment ago (the second click of a double-click, a request that just popped up or changed) must not
 * pay for something the user hasn't seen.
 */
const ARM_MS = 900

/** True once `key` (what the panel shows) has stayed the same for ARM_MS. */
function useArmed(key: string): boolean {
  const [armed, setArmed] = useState<string>()
  useEffect(() => {
    const t = setTimeout(() => setArmed(key), ARM_MS)
    return () => clearTimeout(t)
  }, [key])
  return armed === key
}

const primary =
  'rounded-md bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40'
const secondary = 'rounded-md border border-line px-4 py-2 transition hover:bg-raised disabled:opacity-40'

function ApprovalPanel({ approval: a, position, othersWaiting, hold }: PanelProps) {
  const { models } = useModels()
  const assets = useAssets()
  const photos = useMemo(() => photoIndex(assets), [assets])
  const { sequence, error: sequenceError } = useSequence(a.sequenceId)
  const now = useNow(15_000)

  const [phase, setPhase] = useState<Phase>('review')
  const [error, setError] = useState<string>()
  const [consent, setConsent] = useState<ConsentRequest>()
  const [reason, setReason] = useState('')

  const expiresAt = a.expiresAt ?? a.createdAt + APPROVAL_TTL_MS
  const pending = a.status === 'pending'
  // Main lapses it at expiresAt; don't offer to approve what it would refuse.
  const expired = pending && now > expiresAt
  const clips = useMemo(() => clipsOf(a, sequence), [a, sequence])
  const armed = useArmed(
    JSON.stringify([a.id, a.status, a.priceUsd, clips.map((c) => [c.key, c.title, c.params, c.continuesFrom])])
  )
  // The first clip that can't be generated, named when the request covers several.
  const blockingClip = clips.find((c) => c.blocking)
  const blocking =
    blockingClip && clips.length > 1 && blockingClip.title
      ? `${blockingClip.title}: ${blockingClip.blocking}`
      : blockingClip?.blocking

  const fail = (message: string) => {
    const request = parseConsent(message)
    if (request) {
      setConsent(request)
      setPhase('review')
    } else {
      setError(message)
      setPhase('failed')
    }
  }

  const approve = async () => {
    setPhase('submitting')
    setError(undefined)
    hold(true)
    try {
      const result = await resolveApproval(a.id, true)
      if (result.status === 'approved') {
        hold(false)
        return
      }
      fail(result.error ?? approvalOutcome(result))
    } catch (e) {
      fail(ipcErrorMessage(e))
    }
  }

  const decline = async () => {
    setPhase('submitting')
    setError(undefined)
    try {
      await resolveApproval(a.id, false, reason.trim() || undefined)
      hold(false)
    } catch (e) {
      setError(ipcErrorMessage(e))
      setPhase('failed')
    }
  }

  const acceptConsent = async (request: ConsentRequest) => {
    setConsent(undefined)
    try {
      await window.studio.acceptConsent(request.flow, request.version)
    } catch (e) {
      fail(ipcErrorMessage(e))
      return
    }
    await approve()
  }

  const close = () => {
    if (phase === 'submitting') return
    if (phase === 'declining') return setPhase('review')
    if (phase === 'failed' || !pending) {
      hold(false)
      setPhase('review')
      return
    }
    hold(false)
    deferApproval(a.id)
  }

  if (consent) {
    return (
      <ConsentDialog
        request={consent}
        onAccept={() => void acceptConsent(consent)}
        onCancel={() => {
          setConsent(undefined)
          hold(false)
        }}
      />
    )
  }

  const subtitle = [
    approvalTitle(a, sequence?.name ?? a.sequenceName),
    pending ? expiresText(expiresAt, now) : undefined,
    position && position.total > 1 ? `${position.index} av ${position.total} som väntar` : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  const footer =
    phase === 'declining' ? (
      <>
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void decline()}
          placeholder="Varför? (valfritt – agenten får se det)"
          className="min-w-0 flex-1 rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted"
        />
        <button onClick={() => setPhase('review')} className={secondary}>
          Tillbaka
        </button>
        <button onClick={() => void decline()} className={secondary}>
          Avböj
        </button>
      </>
    ) : !pending && phase === 'review' ? (
      // Lapsed or replaced while it was on screen: nothing to approve here; the next one is opened on purpose.
      <button onClick={close} className={secondary}>
        {othersWaiting ? 'Visa nästa förfrågan' : 'Stäng'}
      </button>
    ) : phase === 'failed' ? (
      <>
        <button onClick={close} className={pending ? `mr-auto ${secondary}` : secondary}>
          Stäng
        </button>
        {pending && (
          <button onClick={() => void approve()} disabled={!!blocking || !armed} className={primary}>
            Försök igen
          </button>
        )}
      </>
    ) : (
      <>
        <button
          onClick={close}
          disabled={phase === 'submitting'}
          title="Låt begäran vänta – du hittar den under Agent i sidofältet"
          className="mr-auto text-[12px] text-muted transition hover:text-text disabled:opacity-40"
        >
          Senare
        </button>
        <button onClick={() => setPhase('declining')} disabled={phase === 'submitting'} className={secondary}>
          Avböj
        </button>
        <button
          onClick={() => void approve()}
          disabled={phase === 'submitting' || !!blocking || !pending || expired || !armed}
          title={
            blocking
              ? `Kan inte genereras: ${blocking}`
              : expired
                ? 'Begäran har gått ut – be agenten fråga igen'
                : !armed
                  ? 'Läs igenom förfrågan först'
                  : undefined
          }
          className={`flex items-center gap-2 ${primary}`}
        >
          <span>{phase === 'submitting' ? 'Skickar…' : 'Godkänn och generera'}</span>
          {phase !== 'submitting' && a.priceUsd !== undefined && (
            <span className="text-white/80">{formatUsd(a.priceUsd)}</span>
          )}
        </button>
      </>
    )

  return (
    <Modal title={`${a.client} vill generera`} subtitle={subtitle} onClose={close} footer={footer} maxWidth={620}>
      <div className="space-y-5">
        {error && (
          <p className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] leading-relaxed text-[#ffb3b5] select-text">
            {error}
          </p>
        )}
        {!pending && phase !== 'failed' && phase !== 'submitting' && (
          <p className="rounded-md border border-line bg-raised px-3 py-2 text-[12px] text-muted">{approvalOutcome(a)}</p>
        )}

        {a.note && (
          <div className="rounded-md border border-line bg-raised/60 px-3 py-2.5">
            <p className="mb-1 text-[11px] text-muted">{a.client} skriver:</p>
            <p className="whitespace-pre-wrap leading-relaxed select-text">{a.note}</p>
          </div>
        )}

        {sequenceError && a.sequenceId && (
          <p className="text-[12px] text-accent">Sekvensen kunde inte läsas: {sequenceError}</p>
        )}

        {clips.map((clip) => (
          <ClipSummary
            key={clip.key}
            clip={clip}
            models={models}
            photos={photos}
            compact={clips.length > 1}
          />
        ))}
        {a.kind === 'generate-all' && sequence && !clips.length && (
          <p className="text-muted">Alla klipp i sekvensen har redan en färdig tagning.</p>
        )}
        {a.kind !== 'generation' && !sequence && !sequenceError && !clips.length && (
          <p className="text-muted">Läser sekvensen…</p>
        )}

        <div className="flex items-baseline justify-between gap-4 border-t border-line pt-4">
          <span className="text-muted">
            {clips.length > 1 ? `Totalt för ${clips.length} klipp` : 'Kostnad'}
            <span className="ml-1.5 text-[11px]">(dras från ditt Venice-konto)</span>
          </span>
          <span className="text-lg font-semibold tabular-nums">
            {a.priceUsd !== undefined ? formatUsd(a.priceUsd) : 'Okänt pris'}
          </span>
        </div>
        {blocking && (
          <p className="text-[12px] text-accent">
            Kan inte genereras som det ser ut nu: {blocking}. Be {a.client} rätta prompten, eller avböj.
          </p>
        )}
      </div>
    </Modal>
  )
}

// ── What will be generated ──────────────────────────────────────────────────

interface Photo {
  asset: Asset
  /** 1-based among the asset's photos. */
  number: number
}

function photoIndex(assets: readonly Asset[]): Map<string, Photo> {
  const map = new Map<string, Photo>()
  for (const asset of assets) asset.images.forEach((img, i) => map.set(img.path, { asset, number: i + 1 }))
  return map
}

interface Clip {
  key: string
  /** "Klipp 3"; undefined for the Generate form. */
  title?: string
  /** What will be sent (inputs the mode doesn't use are dropped). */
  params: GenerationParams
  /** The start frame comes from the previous clip's end, so there is no start image yet. */
  continuesFrom?: number
  blocking?: string
  warnings: string[]
}

function clipOf(key: string, params: GenerationParams, title?: string, continuesFrom?: number): Clip {
  return {
    key,
    title,
    params: paramsForSubmit(params),
    continuesFrom,
    blocking: blockingPromptIssue(params),
    warnings: promptIssuesOf(params)
      .filter((i) => i.severity === 'warning')
      .map((i) => i.message)
  }
}

function segmentClip(segment: Segment, index: number): Clip {
  const continuing = segment.continueFromPrevious && index > 0
  return clipOf(segment.id, effectiveParams(segment, index), `Klipp ${index + 1}`, continuing ? index : undefined)
}

/** The clips a request would generate, in order. */
function clipsOf(a: ApprovalRequest, sequence: Sequence | undefined): Clip[] {
  if (a.kind === 'generation') return a.params ? [clipOf(a.id, a.params)] : []
  const indexed = sequence?.segments.map((segment, index) => ({ segment, index })) ?? []
  if (a.kind === 'segment') {
    const hit = indexed.find(({ segment }) => segment.id === a.segmentIds?.[0])
    const number = hit ? hit.index + 1 : a.clipNumbers?.[0]
    const continuesFrom = hit && hit.segment.continueFromPrevious && hit.index > 0 ? hit.index : undefined
    // Main submits exactly the settings in the request (and refuses if the clip has changed since).
    if (a.params) return [clipOf(a.id, a.params, number ? `Klipp ${number}` : undefined, continuesFrom)]
    return hit ? [segmentClip(hit.segment, hit.index)] : []
  }
  if (!sequence) return []
  const ids = a.segmentIds
  const chosen = ids?.length
    ? indexed.filter(({ segment }) => ids.includes(segment.id))
    : indexed.filter(({ segment }) => needsTake(segment) && !pendingTake(segment))
  return chosen.map(({ segment, index }) => segmentClip(segment, index))
}

function ClipSummary({
  clip,
  models,
  photos,
  compact
}: {
  clip: Clip
  models: VideoModel[]
  photos: ReadonlyMap<string, Photo>
  compact: boolean
}) {
  const p = clip.params
  const model = models.find((m) => m.id === p.model)
  const kind = kindOfModelId(p.model)
  const mode = KINDS.find((k) => k.id === kind)?.label
  const refs = p.referenceImages ?? []
  const targets: TokenTarget[] = refs.map((path) => {
    const photo = photos.get(path)
    return {
      kind: photo?.asset.kind,
      label: photo ? `${photo.asset.name} (foto ${photo.number})` : (path.split('/').pop() ?? path)
    }
  })
  const settings = [
    model?.name ?? p.model,
    mode,
    p.duration,
    p.resolution,
    p.aspectRatio,
    p.audio === undefined ? undefined : p.audio ? 'med ljud' : 'utan ljud'
  ].filter(Boolean)

  return (
    <section className={compact ? 'rounded-lg border border-line p-3' : ''}>
      {clip.title && <h3 className="mb-1.5 font-medium">{clip.title}</h3>}
      <p className="mb-3 text-[12px] text-muted">{settings.join(' · ')}</p>

      <Label>Prompt</Label>
      {p.prompt.trim() ? (
        <PromptText
          prompt={p.prompt}
          targets={targets}
          className={`overflow-y-auto rounded-md border border-line bg-raised px-3 py-2 ${compact ? 'max-h-32' : 'max-h-60'}`}
        />
      ) : (
        <p className="text-accent">Prompten är tom.</p>
      )}

      {p.negativePrompt && (
        <>
          <Label className="mt-3">Negativ prompt</Label>
          <p className="whitespace-pre-wrap text-muted select-text">{p.negativePrompt}</p>
        </>
      )}

      {kind === 'reference-to-video' && refs.length > 0 && (
        <>
          <Label className="mt-3">Referensbilder</Label>
          <div className="flex flex-wrap gap-2">
            {refs.map((path, i) => (
              <ImageTile key={path} path={path} badge={`@Image${i + 1}`} photo={photos.get(path)} />
            ))}
          </div>
        </>
      )}

      {kind === 'image-to-video' && (
        <>
          <Label className="mt-3">Startbild{p.endImage ? ' och slutbild' : ''}</Label>
          <div className="flex flex-wrap items-center gap-2">
            {p.startImage ? (
              <ImageTile path={p.startImage} badge="Start" photo={photos.get(p.startImage)} />
            ) : clip.continuesFrom ? (
              <p className="text-[12px] text-muted">Sista bildrutan från klipp {clip.continuesFrom}.</p>
            ) : (
              <p className="text-[12px] text-accent">Ingen startbild.</p>
            )}
            {p.endImage && <ImageTile path={p.endImage} badge="Slut" photo={photos.get(p.endImage)} />}
          </div>
        </>
      )}

      {(clip.blocking || clip.warnings.length > 0) && (
        <ul className="mt-3 space-y-1 text-[12px]">
          {clip.blocking && <li className="text-accent">{clip.blocking}</li>}
          {clip.warnings.map((w) => (
            <li key={w} className="text-amber-300">
              {w}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`mb-1.5 text-[11px] text-muted ${className}`}>{children}</p>
}

function ImageTile({ path, badge, photo }: { path: string; badge: string; photo?: Photo }) {
  const [missing, setMissing] = useState(false)
  const name = photo ? `${photo.asset.name} (foto ${photo.number})` : (path.split('/').pop() ?? path)
  return (
    <div
      title={missing ? `Filen saknas: ${path}` : `${badge} · ${name}`}
      className={`relative h-16 w-16 shrink-0 overflow-hidden rounded bg-raised ${missing ? 'ring-1 ring-accent' : ''}`}
    >
      {missing ? (
        <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
          Filen saknas
        </span>
      ) : (
        <img
          src={mediaUrl(path)}
          draggable={false}
          onError={() => setMissing(true)}
          className="h-full w-full object-cover"
        />
      )}
      <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">{badge}</span>
      {photo && (
        <span
          className={`absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${KIND_TONE[photo.asset.kind].caption}`}
        >
          {photo.asset.name}
        </span>
      )}
    </div>
  )
}

// ── Hooks ───────────────────────────────────────────────────────────────────

function useSequence(id: string | undefined): { sequence?: Sequence; error?: string } {
  const [state, setState] = useState<{ id?: string; sequence?: Sequence; error?: string }>({})
  useEffect(() => {
    if (!id) return
    let active = true
    const load = () =>
      window.studio.getSequence(id).then(
        (sequence) => active && setState({ id, sequence }),
        (e: unknown) => active && setState({ id, error: ipcErrorMessage(e) })
      )
    void load()
    const off = window.studio.onSequenceChange((changed) => {
      if (changed === id) void load()
    })
    return () => {
      active = false
      off()
    }
  }, [id])
  return state.id === id ? state : {}
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
