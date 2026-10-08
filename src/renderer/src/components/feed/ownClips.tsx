// Own clips ("Egna klipp") in the window: bringing the user's own video files into the library from a file dialog or a
// drop (on the feed, a sequence's timeline, a clip's takes), what is said before (refusals, a large copy, a working
// copy, a film of another shape than the sequence), and the import's progress while it runs. The import itself is
// main's (imports.ts); this decides nothing main doesn't check again.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import type { ImportProgress, ImportResult, ImportTarget, VideoFileInfo } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import Modal from '../pickers/Modal'

/** The file types the import takes (as main's file dialog offers them). */
const VIDEO_FILE = /\.(mp4|mov|m4v|webm|mkv)$/i

/** Main asks before copying more than this when the file can't be cloned into the library's volume. */
const LARGE_COPY_BYTES = 2 * 1024 ** 3

/** Two shapes closer than this are the same for the question "passa in eller beskär". */
const ASPECT_TOLERANCE = 0.05

export function isVideoFile(path: string): boolean {
  return VIDEO_FILE.test(path)
}

/** A drag that carries files from Finder (their names can only be read on drop). */
export function carriesFiles(e: Pick<DragEvent, 'dataTransfer'>): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/**
 * The video files of a drop, as paths; anything else in it (pictures, documents) is left out, so a drop that mixes
 * videos with other files imports only the videos.
 */
export function droppedVideoPaths(e: Pick<DragEvent, 'dataTransfer'>): { paths: string[]; other: boolean } {
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files.map((f) => window.studio.pathForFile(f)).filter((p) => !!p)
  const videos = paths.filter(isVideoFile)
  return { paths: videos, other: videos.length < files.length }
}

// ── Words ────────────────────────────────────────────────────────────────────

/** "3,4 GB", "820 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** "16:9" → 1.78; undefined for "auto", "adaptive" or nothing. */
export function aspectValue(aspect: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(aspect ?? '')
  if (!m) return undefined
  const v = Number(m[1]) / Number(m[2])
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/** "stående", "liggande" or "kvadratisk", for a shape. */
export function shapeWord(aspect: number): string {
  if (Math.abs(aspect - 1) < 0.03) return 'kvadratisk'
  return aspect < 1 ? 'stående' : 'liggande'
}

/** How a working-copy reason reads in "Studio gör en arbetskopia (HDR → SDR, 4K → 1080p)". */
function reasonText(reason: string): string {
  return reason === 'HDR' ? 'HDR → SDR' : reason
}

/** "Studio gör en arbetskopia (HDR → SDR, 4K → 1080p). Originalet sparas bredvid." */
export function workingCopySentence(reasons: readonly string[]): string {
  return `Studio gör en arbetskopia (${reasons.map(reasonText).join(', ')}). Originalet sparas bredvid.`
}

/**
 * The end of an own clip's info line: "arbetskopia av 4K HDR" when the reasons say what the original was, else
 * "arbetskopia (variabel bildfrekvens)"; undefined without a working copy.
 */
export function workingCopyNote(reasons: readonly string[] | undefined): string | undefined {
  if (!reasons?.length) return undefined
  const size = reasons.find((r) => r.includes('→'))?.split('→')[0].trim()
  const parts = [size, reasons.includes('HDR') ? 'HDR' : undefined, reasons.includes('ProRes') ? 'ProRes' : undefined]
    .filter((p): p is string => !!p)
  return parts.length ? `arbetskopia av ${parts.join(' ')}` : `arbetskopia (${reasons.join(', ')})`
}

// ── Progress ─────────────────────────────────────────────────────────────────

/** One file on its way into the library, as the window shows it (a card with a bar and Avbryt). */
export interface ImportCard {
  path: string
  name: string
  fraction: number
  /** Where it goes: the feed, a sequence (new clips) or a clip (a take). */
  target: ImportTarget['kind']
  sequenceId?: string
  segmentId?: string
  /** "Studio gör en arbetskopia (…)", when one is made. */
  note?: string
}

const cards = new Map<string, ImportCard>()
let snapshot: ImportCard[] = []
const listeners = new Set<() => void>()
let subscribed = false

function publish(): void {
  snapshot = [...cards.values()]
  for (const l of listeners) l()
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/** Main's progress events, once for the whole window: cards outlive the view that started the import. */
function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.studio.onImportProgress((p: ImportProgress) => {
    const card = cards.get(p.path)
    if (p.done) {
      // Finished (the clip arrives through the feed and sequence updates), refused or stopped: the card goes. The
      // view that started the import says what went wrong.
      if (card) {
        cards.delete(p.path)
        publish()
      }
      return
    }
    cards.set(p.path, {
      path: p.path,
      name: card?.name ?? fileName(p.path),
      fraction: Math.max(card?.fraction ?? 0, p.fraction),
      target: card?.target ?? (p.segmentId ? 'segment' : p.sequenceId ? 'sequence' : 'feed'),
      sequenceId: p.sequenceId ?? card?.sequenceId,
      segmentId: p.segmentId ?? card?.segmentId,
      note: card?.note
    })
    publish()
  })
}

function subscribe(listener: () => void): () => void {
  ensureSubscribed()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every import running now, live. */
export function useImportCards(): ImportCard[] {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** Registers the files a view is about to import, so their cards show at once (and say where they go). */
function announce(infos: readonly VideoFileInfo[], target: ImportTarget): void {
  ensureSubscribed()
  for (const info of infos) {
    cards.set(info.path, {
      path: info.path,
      name: info.name,
      fraction: 0,
      target: target.kind,
      sequenceId: target.kind === 'sequence' ? target.sequenceId : undefined,
      segmentId: target.kind === 'segment' ? target.segmentId : undefined,
      note: info.workingCopy.length && !info.duplicateOf ? workingCopySentence(info.workingCopy) : undefined
    })
  }
  publish()
}

function forget(paths: readonly string[]): void {
  let changed = false
  for (const p of paths) changed = cards.delete(p) || changed
  if (changed) publish()
}

/** Stops every running import (main has one queue); what is half made is removed. */
/** Stops one file's import (its card's Avbryt); the other files go on. */
export function cancelImport(path: string): void {
  void window.studio.cancelImports(path).catch(() => {})
}

/** A card for a file on its way in: name, "Förbereder… 34 %", a bar and Avbryt. */
export function ImportCardView({ card, compact = false }: { card: ImportCard; compact?: boolean }) {
  const percent = Math.round(card.fraction * 100)
  return (
    <div className={`flex h-full flex-col justify-center gap-2 ${compact ? 'px-3' : 'px-6'} text-[11px] text-muted`}>
      <span className="truncate text-text" title={card.name}>
        {card.name}
      </span>
      <div className="flex items-center gap-2">
        <span className="shrink-0 tabular-nums">Förbereder… {percent} %</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            cancelImport(card.path)
          }}
          title="Avbryter importen av den här filen (det som hunnit kopieras tas bort); de andra filerna fortsätter"
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 transition hover:bg-raised hover:text-text"
        >
          Avbryt
        </button>
      </div>
      <div className="h-1 w-full overflow-hidden rounded bg-raised">
        <div className="h-full bg-accent transition-all duration-500" style={{ width: `${Math.max(3, percent)}%` }} />
      </div>
      {card.note && !compact && <span className="line-clamp-2 leading-snug">{card.note}</span>}
    </div>
  )
}

// ── The flow: look, ask when there is something to decide, import ───────────

/** What the view importing into a sequence knows about it (for "Passa in eller beskär"). */
export interface ImportContext {
  /** The sequence's shape, "16:9" (its first clip's take, else its defaults). */
  sequenceAspect?: string
}

/** What came of an import, for the view to show: what went wrong, and what was reused. */
export interface ImportOutcome {
  result?: ImportResult
  /** Swedish lines: refusals, failures. */
  errors: string[]
  /** Swedish lines worth knowing: "x.mov: Redan importerad – används igen." */
  notes: string[]
}

interface Pending {
  infos: VideoFileInfo[]
  target: ImportTarget
  context: ImportContext
  resolve: (outcome: ImportOutcome) => void
}

/**
 * Brings files in: looks at them first (free), asks only when there is something to decide or to know before
 * copying (a file that can't be imported, a large copy, a film of another shape than the sequence), then imports.
 * Render `dialog` somewhere in the view. `begin` resolves when the import is done (or was called off).
 */
export function useImportFlow(): {
  begin: (paths: string[], target: ImportTarget, context?: ImportContext) => Promise<ImportOutcome>
  inspecting: boolean
  dialog: ReactNode
} {
  const [pending, setPending] = useState<Pending>()
  const [inspecting, setInspecting] = useState(false)
  const [fit, setFit] = useState<'pad' | 'crop'>('pad')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (infos: VideoFileInfo[], target: ImportTarget): Promise<ImportOutcome> => {
    const ok = infos.filter((i) => i.ok)
    const errors = infos.filter((i) => !i.ok).map((i) => i.error ?? `${i.name}: Filen kan inte läsas.`)
    const notes = ok.filter((i) => i.duplicateOf).map((i) => `${i.name}: Redan importerad – används igen.`)
    if (!ok.length) return { errors, notes }
    announce(ok, target)
    try {
      const result = await window.studio.importVideoFiles(
        ok.map((i) => i.path),
        target
      )
      // A file stopped by Avbryt isn't a failure to report: the user asked for it.
      return {
        result,
        errors: [...errors, ...result.errors.filter((e) => !/avbröts/i.test(e.message)).map((e) => e.message)],
        notes
      }
    } catch (e) {
      return { errors: [...errors, ipcErrorMessage(e)], notes }
    } finally {
      forget(ok.map((i) => i.path))
    }
  }, [])

  const begin = useCallback(
    async (paths: string[], target: ImportTarget, context: ImportContext = {}): Promise<ImportOutcome> => {
      const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p))]
      if (!unique.length) return { errors: [], notes: [] }
      setInspecting(true)
      let infos: VideoFileInfo[]
      try {
        infos = await window.studio.inspectVideoFiles(unique)
      } catch (e) {
        return { errors: [ipcErrorMessage(e)], notes: [] }
      } finally {
        if (mounted.current) setInspecting(false)
      }
      const ok = infos.filter((i) => i.ok)
      const refused = infos.some((i) => !i.ok)
      const large = ok.some((i) => !i.cloneable && !i.duplicateOf && i.bytes > LARGE_COPY_BYTES)
      const mismatch = target.kind !== 'feed' && misshapen(ok, context.sequenceAspect).length > 0
      // Nothing to decide and nothing refused: straight in (the cards say the rest).
      if (!refused && !large && !mismatch) return run(infos, target)
      return new Promise<ImportOutcome>((resolve) => {
        setFit('pad')
        setPending({ infos, target, context, resolve })
      })
    },
    [run]
  )

  const close = (go: boolean) => {
    const p = pending
    if (!p) return
    setPending(undefined)
    if (!go) {
      p.resolve({ errors: [], notes: [] })
      return
    }
    const target: ImportTarget = p.target.kind === 'feed' ? p.target : { ...p.target, fit }
    void run(p.infos, target).then(p.resolve)
  }

  const dialog = pending ? (
    <ImportDialog pending={pending} fit={fit} onFit={setFit} onClose={(go) => close(go)} />
  ) : null

  return { begin, inspecting, dialog }
}

/** The files whose shape differs from the sequence's (more than ASPECT_TOLERANCE). */
function misshapen(infos: readonly VideoFileInfo[], sequenceAspect: string | undefined): VideoFileInfo[] {
  const target = aspectValue(sequenceAspect)
  if (!target) return []
  return infos.filter((i) => {
    if (i.duplicateOf) return false
    const a = i.width && i.height ? i.width / i.height : aspectValue(i.aspect)
    return a !== undefined && Math.abs(a - target) > ASPECT_TOLERANCE
  })
}

function ImportDialog({
  pending,
  fit,
  onFit,
  onClose
}: {
  pending: Pending
  fit: 'pad' | 'crop'
  onFit: (fit: 'pad' | 'crop') => void
  onClose: (go: boolean) => void
}) {
  const { infos, target, context } = pending
  const ok = infos.filter((i) => i.ok)
  const refused = infos.filter((i) => !i.ok)
  const odd = target.kind === 'feed' ? [] : misshapen(ok, context.sequenceAspect)
  const sequenceAspect = aspectValue(context.sequenceAspect)
  const first = odd[0]
  const firstAspect = first && first.width && first.height ? first.width / first.height : aspectValue(first?.aspect)

  return (
    <Modal
      title={
        !ok.length
          ? infos.length === 1
            ? 'Filen kan inte importeras'
            : 'Filerna kan inte importeras'
          : ok.length === 1
            ? 'Importera eget klipp'
            : `Importera ${ok.length} egna klipp`
      }
      onClose={() => onClose(false)}
      maxWidth={500}
      footer={
        ok.length ? (
          <>
            <button
              type="button"
              onClick={() => onClose(false)}
              className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised"
            >
              Avbryt
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => onClose(true)}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-white transition hover:bg-accent-hover"
            >
              {ok.length === 1 ? 'Importera' : `Importera ${ok.length}`}
            </button>
          </>
        ) : (
          <button
            type="button"
            autoFocus
            onClick={() => onClose(false)}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised"
          >
            Stäng
          </button>
        )
      }
    >
      <div className="space-y-4 text-[12px] leading-relaxed">
        {refused.length > 0 && (
          <ul className="space-y-1 text-[#ffb3b5]">
            {refused.map((i) => (
              <li key={i.path}>{i.error ?? `${i.name}: Filen kan inte läsas.`}</li>
            ))}
          </ul>
        )}

        {ok.length > 0 && (
          <ul className="space-y-2">
            {ok.map((i) => (
              <li key={i.path} className="rounded-md border border-line px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={i.path}>
                    {i.name}
                  </span>
                  <span className="shrink-0 text-muted tabular-nums">{formatBytes(i.bytes)}</span>
                </div>
                {i.duplicateOf ? (
                  <p className="text-muted">Redan importerad – används igen.</p>
                ) : (
                  <>
                    {!i.cloneable && i.bytes > LARGE_COPY_BYTES && (
                      <p className="text-amber-200">
                        {i.name} är {formatBytes(i.bytes)} och kopieras in i biblioteket. Fortsätt?
                      </p>
                    )}
                    {i.workingCopy.length > 0 && <p className="text-muted">{workingCopySentence(i.workingCopy)}</p>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {odd.length > 0 && sequenceAspect && firstAspect && (
          <fieldset className="space-y-2 rounded-md border border-line p-3">
            <legend className="px-1 text-text">
              {odd.length === 1
                ? `Filmen är ${shapeWord(firstAspect)} (${first.aspect}) och sekvensen ${shapeWord(sequenceAspect)} (${context.sequenceAspect}).`
                : `${odd.length} av filmerna har ett annat format än sekvensen (${context.sequenceAspect}).`}
            </legend>
            <FitChoice
              checked={fit === 'pad'}
              onChange={() => onFit('pad')}
              label="Passa in med kanter"
              text="Ingen ändring: exporten lägger till kanter runt filmen."
            />
            <FitChoice
              checked={fit === 'crop'}
              onChange={() => onFit('crop')}
              label="Fyll bilden (beskär)"
              text="Arbetskopian beskärs till sekvensens format. Originalet sparas bredvid."
            />
            <p className="text-muted">Med kanter fortsätter nästa AI-klipp i filmens eget format.</p>
          </fieldset>
        )}
      </div>
    </Modal>
  )
}

function FitChoice({
  checked,
  onChange,
  label,
  text
}: {
  checked: boolean
  onChange: () => void
  label: string
  text: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="radio" checked={checked} onChange={onChange} className="mt-1 accent-accent" />
      <span>
        <span className="block text-text">{label}</span>
        <span className="block text-muted">{text}</span>
      </span>
    </label>
  )
}

/** A drop zone's overlay text and frame, over whatever it covers while files are dragged onto it. */
export function DropHint({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent/70 bg-accent/10 text-[13px] font-medium text-text backdrop-blur-[1px]">
      {text}
    </div>
  )
}
