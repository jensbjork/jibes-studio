import { useEffect, useMemo, useState } from 'react'
import type { AudioGenModel, EditOperation } from '@shared/types'
import { useOpenCard, useReportRange } from './cards'
import { useCardRun, useEditor } from './EditorContext'
import PromptField from '../prompt/PromptField'
import { formatLength, formatPrice, operationRange } from './editorUtils'
import { usePlan, usePlans } from './useEditOps'
import { Check, Choice, Field, GainSlider, OpCard, PlanNotes, RunButton, TimeAt, fieldInput, textArea } from './ui'

// Musik & effekter: new music under the film (or the marked part of it) and sound effects at a point. Each result
// lands on the Lager lane as a layer, so its volume and place can be changed for free afterwards.

const DEFAULT_MUSIC = 'ace-step-15'
const DEFAULT_EFFECT = 'elevenlabs-sound-effects-v2'

export default function MusicTab() {
  const [open, toggle] = useOpenCard('musik')
  return (
    <div className="space-y-1">
      <MusicCard open={open === 'music'} onToggle={() => toggle('music')} />
      <EffectCard open={open === 'effect'} onToggle={() => toggle('effect')} />
    </div>
  )
}

interface CardProps {
  open: boolean
  onToggle: () => void
}

/** What a model does with the length: "60–210 s", "väljer längden själv (Lyria)". */
function lengthHint(m: AudioGenModel): string {
  if (!m.durationControl) return 'väljer längden själv'
  if (m.durationOptions?.length) {
    const opts = [...m.durationOptions].sort((a, b) => a - b)
    return `${opts[0]}–${opts[opts.length - 1]} s`
  }
  return `${m.minSeconds}–${m.maxSeconds} s`
}

function MusicCard({ open, onToggle }: CardProps) {
  const { edit, current, selection, audio, duration } = useEditor()
  const models = audio.catalog?.music ?? []
  const [prompt, setPrompt] = useState('')
  const [modelChoice, setModelChoice] = useState<string>()
  const [instrumental, setInstrumental] = useState(true)
  const [scope, setScope] = useState<'film' | 'range'>('film')
  const [duck, setDuck] = useState(true)
  const [gain, setGain] = useState(-6)
  const [fades, setFades] = useState(true)
  const [nonce, setNonce] = useState(0)
  const model = models.find((m) => m.id === modelChoice) ?? models.find((m) => m.id === DEFAULT_MUSIC) ?? models[0]
  const range = scope === 'range' && selection ? selection : undefined
  const length = range ? range.end - range.start : duration

  const opFor = (m: AudioGenModel | undefined): EditOperation | undefined =>
    m && prompt.trim()
      ? {
          op: 'music',
          model: m.id,
          prompt: prompt.trim(),
          range,
          instrumental: m.instrumental ? instrumental : undefined,
          gainDb: gain,
          duck,
          fadeSeconds: fades ? 2 : undefined
        }
      : undefined
  const op = opFor(model)
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open && !!op, nonce)
  const prices = usePlans(
    edit.id,
    models.map((m) => opFor(m)),
    current.id,
    open && !!prompt.trim()
  )
  useReportRange(open, operationRange(plan?.operation) ?? range)
  const card = useCardRun(() => setNonce((n) => n + 1))
  const cheapest = useMemo(() => {
    let best: { id: string; usd: number } | undefined
    prices.forEach((p, i) => {
      if (p?.priceUsd !== undefined && !p.problems.length && (!best || p.priceUsd < best.usd)) {
        best = { id: models[i].id, usd: p.priceUsd }
      }
    })
    return best?.id
  }, [prices, models])
  const tooShort = model && prompt.trim() && prompt.trim().length < model.minPromptLength
  const missing = !prompt.trim()
    ? 'Beskriv musiken.'
    : tooShort
      ? `Beskriv musiken med minst ${model!.minPromptLength} tecken.`
      : undefined

  return (
    <OpCard title="Skapa musik" summary="Ny musik under filmen eller markeringen, sänkt när någon pratar." open={open} onToggle={onToggle}>
      <Field label="Beskriv musiken">
        <PromptField
          value={prompt}
          onChange={setPrompt}
          context="music"
          minRows={2}
          maxRows={8}
          limit={model?.promptLimit || undefined}
          title="Beskriv musiken"
          focusHint="Instrument, tempo och känsla – gärna på engelska. Skriv / för en byggsten."
          placeholder="Calm piano, slow tempo, warm and hopeful"
        />
      </Field>
      {model?.instrumental && (
        <Check checked={instrumental} onChange={setInstrumental}>
          Instrumental (utan sång)
        </Check>
      )}
      <Field label="Längd" hint={formatLength(length)}>
        <Choice
          value={range ? 'range' : 'film'}
          onChange={setScope}
          inline
          label="Längd"
          options={[
            { value: 'film', label: 'Hela filmen' },
            { value: 'range', label: 'Markeringen', disabled: !selection, title: selection ? undefined : 'Markera ett avsnitt först' }
          ]}
        />
      </Field>
      <Field label="Modell">
        {!audio.catalog ? (
          <p className="text-[12px] text-muted">{audio.error ?? 'Hämtar Venice musikmodeller…'}</p>
        ) : (
          <Choice
            value={model?.id ?? ''}
            onChange={setModelChoice}
            label="Modell"
            options={models.map((m, i) => {
              const p = prices[i]
              return {
                value: m.id,
                label: (
                  <span className="flex items-baseline gap-2">
                    <span>{m.name}</span>
                    {cheapest === m.id && <span className="text-[11px] text-emerald-300/80">billigast</span>}
                    <span className="text-[11px] tabular-nums text-muted">
                      {p && !p.problems.length && p.priceUsd !== undefined ? formatPrice(p.priceUsd) : ''}
                    </span>
                  </span>
                ),
                hint: lengthHint(m)
              }
            })}
          />
        )}
      </Field>
      <Check checked={duck} onChange={setDuck}>
        Sänk under tal
      </Check>
      <GainSlider value={gain} onChange={setGain} />
      <Check checked={fades} onChange={setFades}>
        Tona in och ut (2 s)
      </Check>
      <PlanNotes plan={plan} error={card.error ?? planError} quiet={missing} />
      <RunButton
        label="Skapa musik"
        plan={plan}
        planning={planning}
        running={card.running}
        disabled={!!missing || !model}
        disabledReason={missing}
        onClick={() => plan && op && void card.run({ op, plan, label: 'Skapa musik' })}
      />
      {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
    </OpCard>
  )
}

function EffectCard({ open, onToggle }: CardProps) {
  const { edit, current, selection, player, audio } = useEditor()
  const models = audio.catalog?.effects ?? []
  const [prompt, setPrompt] = useState('')
  const [modelChoice, setModelChoice] = useState<string>()
  const [seconds, setSeconds] = useState(3)
  const [at, setAt] = useState(() => Math.round((selection?.start ?? player.getTime()) * 100) / 100)
  const [gain, setGain] = useState(0)
  const [nonce, setNonce] = useState(0)
  const model = models.find((m) => m.id === modelChoice) ?? models.find((m) => m.id === DEFAULT_EFFECT) ?? models[0]
  const min = Math.max(1, Math.ceil(model?.minSeconds ?? 1))
  const max = Math.max(min, Math.floor(model?.maxSeconds ?? 22))
  const length = Math.min(max, Math.max(min, seconds))

  // Opening the card puts the effect at the marked range's start, else at the playhead.
  useEffect(() => {
    if (open) setAt(Math.round((selection?.start ?? player.getTime()) * 100) / 100)
  }, [open])

  const op: EditOperation | undefined =
    model && prompt.trim()
      ? { op: 'effect', model: model.id, prompt: prompt.trim(), at, seconds: length, gainDb: gain }
      : undefined
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open && !!op, nonce)
  useReportRange(open, operationRange(op))
  const card = useCardRun(() => setNonce((n) => n + 1))

  return (
    <OpCard title="Skapa ljudeffekt" summary="En dörr som slår igen, regn, steg – där spelhuvudet står." open={open} onToggle={onToggle}>
      <Field label="Beskriv ljudet">
        <PromptField
          value={prompt}
          onChange={setPrompt}
          context="sound"
          minRows={2}
          maxRows={6}
          limit={model?.promptLimit || undefined}
          title="Beskriv ljudet"
          focusHint="Vad som hörs och var – gärna på engelska. Skriv / för en byggsten."
          placeholder="A wooden door slams shut in a quiet hallway"
        />
        <p className="mt-1 text-[11px] text-muted">Skriv gärna på engelska.</p>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Längd">
          <select value={length} onChange={(e) => setSeconds(Number(e.target.value))} className={fieldInput}>
            {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((s) => (
              <option key={s} value={s}>
                {s} s
              </option>
            ))}
          </select>
        </Field>
        {models.length > 1 && (
          <Field label="Modell">
            <select value={model?.id} onChange={(e) => setModelChoice(e.target.value)} className={fieldInput}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <TimeAt label="Börjar vid" value={at} onChange={setAt} player={player} />
      <GainSlider value={gain} onChange={setGain} />
      <PlanNotes plan={plan} error={card.error ?? planError ?? (audio.catalog ? undefined : audio.error)} quiet="Beskriv ljudet." />
      <RunButton
        label="Skapa ljudeffekt"
        plan={plan}
        planning={planning}
        running={card.running}
        disabled={!op}
        disabledReason={!prompt.trim() ? 'Beskriv ljudet.' : undefined}
        onClick={() => plan && op && void card.run({ op, plan, label: 'Skapa ljudeffekt' })}
      />
      {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
    </OpCard>
  )
}
