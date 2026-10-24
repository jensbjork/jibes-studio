import { useMemo, useState, type ReactNode } from 'react'
import { falVideoModel } from '@shared/fal-models'
import { KINDS, PREFERRED } from '@shared/models'
import type { Direction, VideoModel } from '@shared/types'
import { continuityText, defaultsText } from '../../lib/directors'
import Disclosure from '../ui/Disclosure'
import Segmented from '../ui/Segmented'

const select = 'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted'

/** The shortest and longest shot a director may aim for, in seconds (Direction.shotSeconds). */
export const SHOT_SECONDS = { min: 2, max: 15 } as const

/** The middle of the range, where the slider starts when a length is first set. */
const SHOT_SECONDS_START = 5

/** What a new clip's duration aims for: the Shot length label's tooltip. */
const SHOT_LENGTH_HINT = 'What a new clip’s duration aims for'

interface ShotsProps {
  shotSeconds: number | undefined
  continuity: Direction['continuity']
  onShotSeconds: (seconds: number | undefined, now: boolean) => void
  onContinuity: (continuity: Direction['continuity']) => void
}

/** "Between shots" as a choice: the sequence's own is no continuity of the director's. */
type Between = 'cut' | 'flow' | 'own'

const CONTINUITY: { value: Between; label: string; text: string }[] = [
  { value: 'cut', label: 'Cut', text: 'New clips start fresh – hard cuts between the shots.' },
  { value: 'flow', label: 'Flow', text: 'New clips continue from the last frame of the clip before them.' },
  { value: 'own', label: 'Sequence’s own', text: 'New clips do as the sequence does without a director.' }
]

/**
 * How a director cuts a sequence it leads: the shot length it aims for (a song's clips and new clips get the
 * nearest length the model offers) and what happens between shots (Cut, Flow or the sequence's own). Only new clips
 * get them; existing clips aren't changed.
 */
export function ShotSettings({ shotSeconds, continuity, onShotSeconds, onContinuity }: ShotsProps) {
  const on = typeof shotSeconds === 'number'
  const value = on ? shotSeconds : SHOT_SECONDS_START
  const between: Between = continuity ?? 'own'
  const chosen = CONTINUITY.find((c) => c.value === between) ?? CONTINUITY[2]
  return (
    <div className="grid gap-x-5 gap-y-4 @min-[34rem]/fields:grid-cols-2">
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span title={SHOT_LENGTH_HINT} className="font-medium">
            Shot length
          </span>
          <span className="flex-1" />
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Aim for a shot length"
            onClick={() => onShotSeconds(on ? undefined : SHOT_SECONDS_START, true)}
            className={`relative h-4 w-7 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-line'}`}
            title={on ? 'Leave the length to the sequence' : `Aim for a shot length – ${SHOT_LENGTH_HINT.toLowerCase()}`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left] ${on ? 'left-[14px]' : 'left-0.5'}`}
            />
          </button>
        </div>
        <div className={`flex items-center gap-3 ${on ? '' : 'opacity-45'}`}>
          <input
            type="range"
            min={SHOT_SECONDS.min}
            max={SHOT_SECONDS.max}
            step={1}
            value={value}
            disabled={!on}
            aria-label="Shot length in seconds"
            onChange={(e) => onShotSeconds(Number(e.target.value), false)}
            className="min-w-0 flex-1 accent-accent"
          />
          <span className="w-12 shrink-0 text-right tabular-nums">{on ? `${value} s` : 'Any'}</span>
        </div>
      </div>
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="font-medium">Between shots</span>
        </div>
        <Segmented
          value={between}
          onChange={(v) => onContinuity(v === 'own' ? undefined : v)}
          options={CONTINUITY.map((c) => ({ value: c.value, label: c.label, title: c.text }))}
          ariaLabel="Between shots"
          fill
        />
        <p className="mt-1 text-[11px] leading-snug text-muted">{chosen.text}</p>
      </div>
    </div>
  )
}

/** "Hard cuts · 6 s shots": a director's shot settings in words, for a read-only line. */
export function shotSettingsText(direction: Direction): string | undefined {
  const parts = [
    continuityText(direction.continuity),
    typeof direction.shotSeconds === 'number' ? `${direction.shotSeconds} s shots` : ''
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

/** A model's name for the defaults line (its id while the list hasn't loaded or no longer has it). */
export function modelNamer(models: readonly VideoModel[]): (id: string) => string {
  return (id) => models.find((m) => m.id === id)?.name ?? falVideoModel(id)?.name ?? id
}

// ── Defaults ─────────────────────────────────────────────────────────────────

type Defaults = NonNullable<Direction['defaults']>

interface DefaultsProps {
  value: Defaults | undefined
  models: VideoModel[]
  onChange: (next: Defaults | undefined) => void
}

/** The options for a setting: the model's own, else every model's (online), in the app's preferred order first. */
function optionsFor(models: VideoModel[], model: VideoModel | undefined, key: 'aspectRatios' | 'resolutions'): string[] {
  const list = model ? model[key] : [...new Set(models.filter((m) => !m.offline).flatMap((m) => m[key]))]
  const preferred = key === 'aspectRatios' ? ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] : PREFERRED.resolutions
  const rank = (x: string) => {
    const i = preferred.indexOf(x)
    return i === -1 ? preferred.length : i
  }
  return [...list].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }))
}

/**
 * What choosing the director sets in Generate's form or as a sequence's or a storyboard's defaults: a model, an
 * aspect ratio and a resolution, each optional ("Keep" leaves the form's own). Each is applied only where the model
 * offers it.
 */
export function DefaultSettings({ value, models, onChange }: DefaultsProps) {
  const d = value ?? {}
  const model = models.find((m) => m.id === d.model)
  const byKind = useMemo(
    () =>
      KINDS.map((k) => ({
        kind: k,
        models: models.filter((m) => m.kind === k.id && !m.offline).sort((a, b) => a.name.localeCompare(b.name))
      })),
    [models]
  )
  const set = (key: keyof Defaults, v: string) => {
    const next: Defaults = { ...d }
    if (v) next[key] = v
    else delete next[key]
    onChange(Object.keys(next).length ? next : undefined)
  }
  const ratios = optionsFor(models, model, 'aspectRatios')
  const resolutions = optionsFor(models, model, 'resolutions')
  return (
    <div className="grid gap-2 @min-[34rem]/fields:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <label className="min-w-0">
        <span className="mb-1.5 block text-muted">Model</span>
        <select value={d.model ?? ''} onChange={(e) => set('model', e.target.value)} className={select}>
          <option value="">Keep the form’s</option>
          {d.model && !model && <option value={d.model}>{d.model}</option>}
          {byKind.map(
            (g) =>
              g.models.length > 0 && (
                <optgroup key={g.kind.id} label={g.kind.label}>
                  {g.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )
          )}
        </select>
      </label>
      <label className="min-w-0">
        <span className="mb-1.5 block text-muted">Aspect ratio</span>
        <select value={d.aspectRatio ?? ''} onChange={(e) => set('aspectRatio', e.target.value)} className={select}>
          <option value="">Keep</option>
          {d.aspectRatio && !ratios.includes(d.aspectRatio) && <option value={d.aspectRatio}>{d.aspectRatio}</option>}
          {ratios.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label className="min-w-0">
        <span className="mb-1.5 block text-muted">Resolution</span>
        <select value={d.resolution ?? ''} onChange={(e) => set('resolution', e.target.value)} className={select}>
          <option value="">Keep</option>
          {d.resolution && !resolutions.includes(d.resolution) && <option value={d.resolution}>{d.resolution}</option>}
          {resolutions.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

// ── The section ──────────────────────────────────────────────────────────────

/** Open or closed as it was last left while the window is open: it stays so from one director to the next. */
let settingsOpen = false

/**
 * "Shots and defaults": the rarely changed settings of a director, folded into one row under its style frames and
 * videos – what they are set to, in a line ("Hard cuts · 6 s shots · 16:9") – that opens to the shot settings and the
 * defaults. Closed by default, also when something is set (every ready-made one sets something, so every copy would
 * open otherwise).
 */
export function DirectorSettingsSection({
  direction,
  models,
  children
}: {
  direction: Direction
  models: readonly VideoModel[]
  /** The settings: ShotSettings and DefaultSettings, each under its SectionTitle. */
  children: ReactNode
}) {
  const [open, setOpen] = useState(settingsOpen)
  const summary =
    [shotSettingsText(direction), defaultsText(direction, modelNamer(models))].filter(Boolean).join(' · ') ||
    'Not set – the sequence and the form decide'
  return (
    <Disclosure
      open={open}
      onToggle={(next) => {
        settingsOpen = next
        setOpen(next)
      }}
      plain
      summary={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-medium text-text">Shots and defaults</span>
          <span className="truncate text-[11px]">{summary}</span>
        </span>
      }
    >
      <div className="mt-3 space-y-9">{children}</div>
    </Disclosure>
  )
}
