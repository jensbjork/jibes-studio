import { useEffect, useMemo, useState } from 'react'
import type {
  Asset,
  BackgroundChoice,
  EditOperation,
  SpeechModel,
  TranscriptSegment,
  VoiceChoice
} from '@shared/types'
import { ipcErrorMessage, useAssets } from '../../lib/hooks'
import { openCard, useOpenCard, useReportRange } from './cards'
import { useCardRun, useEditor } from './EditorContext'
import { fileName, formatClock, segmentsInRange } from './editorUtils'
import { usePlan } from './useEditOps'
import { Check, Choice, Field, OpCard, PlanNotes, RunButton, TimeAt, fieldInput, linkButton, textArea } from './ui'

// Voice: what is said and who says it. Transcribe (the lines with their times; needed for the rest), Change voice
// (speech-to-speech that keeps the performance, shown only when Venice lists a voice changer), Re-record lines (new
// spoken lines in a preset or cloned voice, laid over the old ones) and New line (a line of its own).

const DEFAULT_ASR = 'elevenlabs/scribe-v2'
const DEFAULT_SPEECH = 'elevenlabs-tts-multilingual-v2'
const CLONE_MODEL = 'tts-chatterbox-hd'


export const LANGUAGES: { code: string; label: string }[] = [
  { code: '', label: 'Automatic' },
  { code: 'sv', label: 'Swedish' },
  { code: 'en', label: 'English' },
  { code: 'no', label: 'Norwegian' },
  { code: 'da', label: 'Danish' },
  { code: 'fi', label: 'Finnish' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' }
]

export function languageName(code: string | undefined): string | undefined {
  if (!code) return undefined
  return LANGUAGES.find((l) => l.code && code.toLowerCase().startsWith(l.code))?.label ?? code
}

export default function VoiceTab() {
  const [open, toggle] = useOpenCard('rost')
  const { timeline } = useEditor()
  const silent = timeline && !timeline.hasAudio
  return (
    <div className="space-y-1">
      {silent && (
        <p className="mx-3 mb-2 rounded-md border border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
          The film has no sound. You can still add new lines.
        </p>
      )}
      <TranscribeCard open={open === 'transcribe'} onToggle={() => toggle('transcribe')} />
      <ChangeVoiceCard open={open === 'change-voice'} onToggle={() => toggle('change-voice')} />
      <SpeakLinesCard
        open={open === 'speak-lines'}
        onToggle={() => toggle('speak-lines')}
        onTranscribe={() => openCard('rost', 'transcribe')}
      />
      <NewLineCard open={open === 'new-line'} onToggle={() => toggle('new-line')} />
    </div>
  )
}

interface CardProps {
  open: boolean
  onToggle: () => void
}

// ── Transcribe ───────────────────────────────────────────────────────────────

function TranscribeCard({ open, onToggle }: CardProps) {
  const { edit, current, transcript, audio } = useEditor()
  const models = audio.catalog?.transcription ?? []
  const [model, setModel] = useState<string>()
  const [language, setLanguage] = useState('')
  const [nonce, setNonce] = useState(0)
  const modelId = model ?? (models.some((m) => m.id === DEFAULT_ASR) ? DEFAULT_ASR : models[0]?.id)
  const op: EditOperation = { op: 'transcribe', model: modelId, language: language || undefined }
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open, nonce)
  const card = useCardRun(() => setNonce((n) => n + 1))
  const count = transcript?.segments.length ?? 0

  const status = transcript
    ? `Transcribed · ${count} ${count === 1 ? 'line' : 'lines'}${
        transcript.language ? ` · ${languageName(transcript.language)}` : ''
      }`
    : transcript === null
      ? 'No transcript yet.'
      : undefined

  return (
    <OpCard
      title="Transcribe"
      summary={status ?? 'What is said, with times. Needed to change lines.'}
      open={open}
      onToggle={onToggle}
    >
      {status && <p className="text-[12px] text-muted">{status}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Language">
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={fieldInput}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
        {models.length > 1 && (
          <Field label="Model">
            <select value={modelId} onChange={(e) => setModel(e.target.value)} className={fieldInput}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted">
        The lines land on the timeline and under Text, where you can correct them for free. Venice doesn’t tell
        speakers apart.
      </p>
      <PlanNotes plan={plan} error={card.error ?? planError ?? audio.error} />
      <RunButton
        label={transcript ? 'Transcribe again' : 'Transcribe'}
        plan={plan}
        planning={planning}
        running={card.running}
        onClick={() => plan && void card.run({ op, plan, label: 'Transcribe' })}
      />
      {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
    </OpCard>
  )
}

// ── Background (shared by Change voice and Re-record lines) ──────────────────

function useBackground(): [BackgroundChoice, (b: BackgroundChoice) => void, boolean] {
  const { separation } = useEditor()
  const separated = !!separation?.available
  const [choice, setChoice] = useState<BackgroundChoice>()
  const value = choice && (separated || choice !== 'keep') ? choice : separated ? 'keep' : 'duck'
  return [value, setChoice, separated]
}

function BackgroundField({
  value,
  onChange,
  separated
}: {
  value: BackgroundChoice
  onChange: (b: BackgroundChoice) => void
  separated: boolean
}) {
  return (
    <Field label="Background">
      <Choice
        value={value}
        onChange={onChange}
        label="Background"
        options={
          separated
            ? [
                { value: 'keep', label: 'Keep the background sound', hint: 'Music and effects stay under the new voice.' },
                { value: 'remove', label: 'Remove it' }
              ]
            : [
                { value: 'duck', label: 'Lower the original sound where the voice changes' },
                { value: 'remove', label: 'Remove it' }
              ]
        }
      />
    </Field>
  )
}

// ── Change voice ─────────────────────────────────────────────────────────────

type Scope = 'film' | 'range' | 'lines'

function ChangeVoiceCard({ open, onToggle }: CardProps) {
  const { edit, current, selection, transcript, audio } = useEditor()
  const changers = audio.catalog?.voiceChangers ?? []
  const [modelChoice, setModelChoice] = useState<string>()
  const model = changers.find((m) => m.id === modelChoice) ?? changers[0]
  const [voice, setVoice] = useState<string>()
  const [custom, setCustom] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [scope, setScope] = useState<Scope>('film')
  const [lineIds, setLineIds] = useState<string[]>([])
  const [background, setBackground, separated] = useBackground()
  const [noiseChoice, setNoiseChoice] = useState<boolean>()
  const [nonce, setNonce] = useState(0)

  const voiceId = voice && model?.voices.includes(voice) ? voice : (model?.defaultVoice ?? model?.voices[0])
  const voiceChoice: VoiceChoice | undefined =
    useCustom && model?.customVoiceId
      ? custom.trim()
        ? { kind: 'custom', voiceId: custom.trim() }
        : undefined
      : voiceId
        ? { kind: 'preset', voice: voiceId }
        : undefined
  const effectiveScope: Scope =
    scope === 'range' && !selection ? 'film' : scope === 'lines' && !transcript?.segments.length ? 'film' : scope
  // Without separation the whole mix is uploaded, so the model's noise removal keeps music and effects from being
  // "converted" too; with separation only the voice goes.
  const removeNoise = model?.backgroundNoiseRemoval ? (noiseChoice ?? !separated) : undefined

  const op: EditOperation | undefined =
    model && voiceChoice && (effectiveScope !== 'lines' || lineIds.length)
      ? {
          op: 'change-voice',
          model: model.id,
          voice: voiceChoice as Exclude<VoiceChoice, { kind: 'clone' }>,
          range: effectiveScope === 'range' ? selection : undefined,
          segmentIds: effectiveScope === 'lines' ? lineIds : undefined,
          background,
          removeNoise
        }
      : undefined
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open && !!op, nonce)
  useReportRange(open, effectiveScope === 'range' ? selection : undefined)
  const card = useCardRun(() => setNonce((n) => n + 1))

  if (!audio.catalog) {
    return (
      <OpCard title="Change voice" summary="Keep the performance, change the voice." open={open} onToggle={onToggle}>
        <p className="text-[12px] text-muted">{audio.error ?? 'Loading Venice’s voice models…'}</p>
      </OpCard>
    )
  }

  if (!changers.length) {
    return (
      <OpCard title="Change voice" summary="Not available from Venice right now." open={open} onToggle={onToggle}>
        <p className="text-[12px] leading-relaxed text-muted">
          Venice doesn’t offer voice changing right now – use <span className="text-text">Re-record lines</span>.
          Studio shows this card by itself once Venice starts offering it.
        </p>
        {!audio.catalog.keyed && (
          <p className="text-[12px] leading-relaxed text-muted">Add the API key in Settings.</p>
        )}
        <button type="button" onClick={audio.refresh} disabled={audio.loading} className={linkButton}>
          {audio.loading ? 'Checking…' : 'Check again'}
        </button>
      </OpCard>
    )
  }

  return (
    <OpCard title="Change voice" summary="Keep the performance, change the voice – for the whole film or a part." open={open} onToggle={onToggle}>
      <Field label="What">
        <Choice
          value={effectiveScope}
          onChange={setScope}
          label="What"
          options={[
            { value: 'film', label: 'The whole film' },
            { value: 'range', label: 'The selection', disabled: !selection, title: selection ? undefined : 'Mark a section first' },
            {
              value: 'lines',
              label: 'Chosen lines',
              disabled: !transcript?.segments.length,
              hint: 'To change only one person’s voice when two people talk.',
              title: transcript?.segments.length ? undefined : 'Transcribe the film first'
            }
          ]}
        />
      </Field>
      {effectiveScope === 'lines' && transcript && (
        <LinePicker segments={transcript.segments} selected={lineIds} onChange={setLineIds} />
      )}
      {changers.length > 1 && (
        <Field label="Model">
          <select value={model?.id} onChange={(e) => setModelChoice(e.target.value)} className={fieldInput}>
            {changers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="New voice">
        <select
          value={useCustom ? '__custom' : (voiceId ?? '')}
          onChange={(e) => {
            if (e.target.value === '__custom') setUseCustom(true)
            else {
              setUseCustom(false)
              setVoice(e.target.value)
            }
          }}
          className={fieldInput}
        >
          {model?.voices.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
          {model?.customVoiceId && <option value="__custom">Own voice ID…</option>}
        </select>
        {useCustom && (
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Voice ID from the provider"
            spellCheck={false}
            className={`${fieldInput} mt-1.5`}
          />
        )}
      </Field>
      <BackgroundField value={background} onChange={setBackground} separated={separated} />
      {model?.backgroundNoiseRemoval && (
        <Check
          checked={!!removeNoise}
          onChange={setNoiseChoice}
          hint={separated ? undefined : 'Recommended: otherwise the model tries to convert music and effects too.'}
        >
          Clean up background noise first
        </Check>
      )}
      <PlanNotes plan={plan} error={card.error ?? planError} />
      <RunButton
        label="Change voice"
        plan={plan}
        planning={planning}
        running={card.running}
        approximate
        disabled={!op}
        disabledReason={effectiveScope === 'lines' ? 'Choose at least one line.' : 'Choose a voice.'}
        onClick={() => plan && op && void card.run({ op, plan, label: 'Change voice' })}
      />
      {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
    </OpCard>
  )
}

/** Checkboxes for transcript lines (Chosen lines). */
function LinePicker({
  segments,
  selected,
  onChange
}: {
  segments: TranscriptSegment[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const { selection } = useEditor()
  const set = new Set(selected)
  const toggle = (id: string) => onChange(set.has(id) ? selected.filter((x) => x !== id) : [...selected, id])
  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <button type="button" onClick={() => onChange(segments.map((s) => s.id))} className={linkButton}>
          All
        </button>
        <button type="button" onClick={() => onChange([])} className={linkButton}>
          None
        </button>
        {selection && (
          <button
            type="button"
            onClick={() => onChange(segmentsInRange(segments, selection).map((s) => s.id))}
            className={linkButton}
          >
            Those in the selection
          </button>
        )}
      </div>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-line p-1">
        {segments.map((s) => (
          <li key={s.id}>
            <label className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-raised/60">
              <input type="checkbox" checked={set.has(s.id)} onChange={() => toggle(s.id)} className="mt-0.5 accent-accent" />
              <span className="w-12 shrink-0 text-[11px] tabular-nums text-muted">{formatClock(s.start)}</span>
              <span className="min-w-0 flex-1 text-[12px] leading-snug">{s.text}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Voices for new lines (Re-record lines, New line) ────────────────────────

interface SpeechVoice {
  mode: 'clone' | 'preset'
  audioId?: string
  model?: string
  voice?: string
  custom?: string
  style?: string
}

interface ResolvedVoice {
  model?: SpeechModel
  voice?: VoiceChoice
  /** Why no voice can be used yet. */
  missing?: string
  /** The clone needs the user's checkbox first. */
  needsConsent?: { audioId: string; name: string }
}

/** Characters' Voice clips that could be cloned, with the character's name. */
function useVoiceClips(): { assetName: string; clip: Asset['audio'][number] }[] {
  const assets = useAssets('character')
  return useMemo(
    () => assets.flatMap((a) => a.audio.map((clip) => ({ assetName: a.name, clip }))),
    [assets]
  )
}

function useSpeechVoice(value: SpeechVoice, consentOverride: Record<string, boolean>): ResolvedVoice {
  const { audio } = useEditor()
  const clips = useVoiceClips()
  const speech = audio.catalog?.speech ?? []
  if (value.mode === 'clone') {
    const model = speech.find((m) => m.id === CLONE_MODEL) ?? speech.find((m) => m.cloning)
    if (!model) return { missing: 'Venice doesn’t offer voice cloning right now.' }
    const entry = clips.find((c) => c.clip.id === value.audioId) ?? clips[0]
    if (!entry) return { model, missing: 'No character has a voice clip yet (Characters → Voice).' }
    const consent = consentOverride[entry.clip.id] ?? entry.clip.cloneConsent
    return {
      model,
      voice: { kind: 'clone', audioId: entry.clip.id },
      needsConsent: consent ? undefined : { audioId: entry.clip.id, name: entry.assetName }
    }
  }
  const presets = speech.filter((m) => m.voices.length || m.customVoiceId)
  const model =
    presets.find((m) => m.id === value.model) ?? presets.find((m) => m.id === DEFAULT_SPEECH) ?? presets[0]
  if (!model) return { missing: audio.error ?? 'Loading Venice’s voice models…' }
  if (value.voice === '__custom') {
    const id = value.custom?.trim()
    return id ? { model, voice: { kind: 'custom', voiceId: id } } : { model, missing: 'Type the voice ID.' }
  }
  const voice = value.voice && model.voices.includes(value.voice) ? value.voice : (model.defaultVoice ?? model.voices[0])
  return voice ? { model, voice: { kind: 'preset', voice } } : { model, missing: 'Choose a voice.' }
}

function SpeechVoiceField({
  value,
  onChange,
  resolved,
  onConsent
}: {
  value: SpeechVoice
  onChange: (v: SpeechVoice) => void
  resolved: ResolvedVoice
  onConsent: (audioId: string, consent: boolean) => void
}) {
  const { audio } = useEditor()
  const clips = useVoiceClips()
  const speech = audio.catalog?.speech ?? []
  const presets = speech.filter((m) => m.voices.length || m.customVoiceId)
  const canClone = speech.some((m) => m.id === CLONE_MODEL || m.cloning)
  const model = resolved.model
  const chosenClip = value.audioId ?? clips[0]?.clip.id
  return (
    <Field label="Voice">
      <Choice
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode })}
        label="Voice"
        options={[
          {
            value: 'clone',
            label: 'The character’s voice',
            hint: 'Cloned from the voice sample. Swedish is untested – listen to the first line before doing the whole film.',
            disabled: !canClone,
            title: canClone ? undefined : 'Venice doesn’t offer voice cloning right now.'
          },
          { value: 'preset', label: 'A ready-made voice' }
        ]}
      />
      <div className="mt-2 space-y-1.5">
        {value.mode === 'clone' ? (
          clips.length ? (
            <>
              <select
                value={chosenClip}
                onChange={(e) => onChange({ ...value, audioId: e.target.value })}
                className={fieldInput}
              >
                {clips.map((c) => (
                  <option key={c.clip.id} value={c.clip.id}>
                    {c.assetName} – {fileName(c.clip.path)}
                  </option>
                ))}
              </select>
              {resolved.voice?.kind === 'clone' && (
                <Check
                  checked={!resolved.needsConsent}
                  onChange={(on) => onConsent((resolved.voice as { audioId: string }).audioId, on)}
                  hint="Needed once per voice clip before the voice is cloned. The same choice is under Characters → Voice."
                >
                  I have the right to use this voice
                </Check>
              )}
            </>
          ) : (
            <p className="text-[12px] text-muted">No character has a voice clip yet (Characters → Voice).</p>
          )
        ) : (
          <>
            {presets.length > 1 && (
              <select
                value={model?.id ?? ''}
                onChange={(e) => onChange({ ...value, model: e.target.value, voice: undefined })}
                className={fieldInput}
              >
                {presets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            {model && (
              <select
                value={resolved.voice?.kind === 'custom' || value.voice === '__custom' ? '__custom' : resolved.voice?.kind === 'preset' ? resolved.voice.voice : ''}
                onChange={(e) => onChange({ ...value, voice: e.target.value })}
                className={fieldInput}
              >
                {model.voices.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                {model.customVoiceId && <option value="__custom">Own voice ID…</option>}
              </select>
            )}
            {value.voice === '__custom' && (
              <input
                value={value.custom ?? ''}
                onChange={(e) => onChange({ ...value, custom: e.target.value })}
                placeholder="Voice ID from the provider"
                spellCheck={false}
                className={fieldInput}
              />
            )}
          </>
        )}
        {model?.stylePrompt && (
          <input
            value={value.style ?? ''}
            onChange={(e) => onChange({ ...value, style: e.target.value })}
            placeholder="Tone, e.g. happy, whispering, tired"
            spellCheck={false}
            className={fieldInput}
            aria-label="Tone"
          />
        )}
      </div>
    </Field>
  )
}

/**
 * Consent given right here (it is the user's own click), remembered until the asset list catches up. `saved` counts
 * the answers main has stored, so the card's plan is made again with the consent in place.
 */
function useCloneConsent(): {
  consent: Record<string, boolean>
  setConsent: (audioId: string, consent: boolean) => void
  saved: number
  error?: string
} {
  const [override, setOverride] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState(0)
  const [error, setError] = useState<string>()
  const setConsent = (audioId: string, consent: boolean) => {
    setError(undefined)
    setOverride((m) => ({ ...m, [audioId]: consent }))
    window.studio.setVoiceCloneConsent(audioId, consent).then(
      () => setSaved((n) => n + 1),
      (e: unknown) => {
        setOverride((m) => {
          const next = { ...m }
          delete next[audioId]
          return next
        })
        setError(ipcErrorMessage(e))
      }
    )
  }
  return { consent: override, setConsent, saved, error }
}

// ── Re-record lines ──────────────────────────────────────────────────────────

function SpeakLinesCard({ open, onToggle, onTranscribe }: CardProps & { onTranscribe: () => void }) {
  const { edit, current, transcript, selection } = useEditor()
  const segments = transcript?.segments ?? []
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [checked, setChecked] = useState<string[]>([])
  const [voiceValue, setVoiceValue] = useState<SpeechVoice>({ mode: 'preset' })
  const [fit, setFit] = useState<'tempo' | 'overlap'>('tempo')
  const [background, setBackground, separated] = useBackground()
  const clone = useCloneConsent()
  const [nonce, setNonce] = useState(0)
  const resolved = useSpeechVoice(voiceValue, clone.consent)

  // Lines that are no longer in the transcript (a new transcription) drop out of the selection.
  useEffect(() => {
    const ids = new Set(segments.map((s) => s.id))
    setChecked((c) => (c.every((id) => ids.has(id)) ? c : c.filter((id) => ids.has(id))))
  }, [transcript])

  const lines = segments
    .filter((s) => checked.includes(s.id))
    .map((s) => ({ segmentId: s.id, text: (texts[s.id] ?? s.text).trim() }))
    .filter((l) => l.text)
  const op: EditOperation | undefined =
    resolved.model && resolved.voice && lines.length
      ? {
          op: 'speak-lines',
          model: resolved.model.id,
          voice: resolved.voice,
          lines,
          background,
          fit,
          style: voiceValue.style?.trim() || undefined,
          language: resolved.model.languageCode ? transcript?.language : undefined
        }
      : undefined
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open && !!op, [nonce, clone.saved])
  const card = useCardRun(() => setNonce((n) => n + 1))

  const rewrite = (id: string, text: string) => {
    setTexts((m) => ({ ...m, [id]: text }))
    setChecked((c) => (c.includes(id) ? c : [...c, id]))
  }
  const blocked = resolved.missing ?? (resolved.needsConsent ? 'Tick that you have the right to use the voice.' : undefined)

  return (
    <OpCard
      title="Re-record lines"
      summary="Rewrite lines and let another voice – or the character’s cloned voice – say them."
      open={open}
      onToggle={onToggle}
    >
      {!transcript?.segments.length ? (
        <div className="space-y-2">
          <p className="text-[12px] leading-relaxed text-muted">
            Transcribe the film first – then you can choose lines and rewrite them.
          </p>
          <button type="button" onClick={onTranscribe} className={linkButton}>
            Go to Transcribe
          </button>
        </div>
      ) : (
        <>
          <div>
            <div className="mb-1 flex items-center gap-1">
              <span className="mr-auto text-muted">Lines</span>
              <button type="button" onClick={() => setChecked(segments.map((s) => s.id))} className={linkButton}>
                All
              </button>
              <button type="button" onClick={() => setChecked([])} className={linkButton}>
                None
              </button>
              {selection && (
                <button
                  type="button"
                  onClick={() => setChecked(segmentsInRange(segments, selection).map((s) => s.id))}
                  className={linkButton}
                >
                  Those in the selection
                </button>
              )}
            </div>
            <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
              {segments.map((s) => {
                const on = checked.includes(s.id)
                const text = texts[s.id] ?? s.text
                return (
                  <li key={s.id} className={`rounded-md border px-2 py-1.5 ${on ? 'border-line bg-raised/40' : 'border-transparent'}`}>
                    <label className="flex items-center gap-2 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setChecked((c) => (on ? c.filter((x) => x !== s.id) : [...c, s.id]))}
                        className="accent-accent"
                      />
                      <span className="tabular-nums">{formatClock(s.start)}</span>
                      {text !== s.text && <span className="min-w-0 truncate line-through opacity-70">{s.text}</span>}
                    </label>
                    <textarea
                      value={text}
                      onChange={(e) => rewrite(s.id, e.target.value)}
                      rows={1}
                      spellCheck={false}
                      aria-label={`New text for the line at ${formatClock(s.start)}`}
                      className="mt-1 block w-full resize-none rounded border border-transparent bg-transparent px-1 py-0.5 text-[12px] leading-snug outline-none transition [field-sizing:content] hover:border-line focus:border-muted focus:bg-raised"
                    />
                  </li>
                )
              })}
            </ul>
          </div>
          <SpeechVoiceField value={voiceValue} onChange={setVoiceValue} resolved={resolved} onConsent={clone.setConsent} />
          <Field label="If a line gets too long">
            <Choice
              value={fit}
              onChange={setFit}
              label="If a line gets too long"
              options={[
                { value: 'tempo', label: 'Adjust the tempo (at most 15%)' },
                { value: 'overlap', label: 'Let it run long', hint: 'It may run into the next line.' }
              ]}
            />
          </Field>
          <BackgroundField value={background} onChange={setBackground} separated={separated} />
          <PlanNotes plan={plan} error={card.error ?? planError ?? clone.error} />
          <RunButton
            label={`Record checked lines${lines.length ? ` (${lines.length})` : ''}`}
            plan={plan}
            planning={planning}
            running={card.running}
            approximate={resolved.model?.endpoint === 'speech'}
            disabled={!op || !!blocked}
            disabledReason={!lines.length ? 'Check at least one line.' : blocked}
            onClick={() => plan && op && void card.run({ op, plan, label: `Record ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}` })}
          />
          {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
        </>
      )}
    </OpCard>
  )
}

// ── New line ─────────────────────────────────────────────────────────────────

function NewLineCard({ open, onToggle }: CardProps) {
  const { edit, current, player, transcript } = useEditor()
  const [text, setText] = useState('')
  const [at, setAt] = useState(() => Math.round(player.getTime() * 100) / 100)
  const [voiceValue, setVoiceValue] = useState<SpeechVoice>({ mode: 'preset' })
  const clone = useCloneConsent()
  const [nonce, setNonce] = useState(0)
  const resolved = useSpeechVoice(voiceValue, clone.consent)

  // Opening the card places the line where the playhead is.
  useEffect(() => {
    if (open) setAt(Math.round(player.getTime() * 100) / 100)
  }, [open])

  const op: EditOperation | undefined =
    resolved.model && resolved.voice && text.trim()
      ? {
          op: 'speak-lines',
          model: resolved.model.id,
          voice: resolved.voice,
          lines: [{ at, text: text.trim() }],
          background: 'duck',
          fit: 'overlap',
          style: voiceValue.style?.trim() || undefined,
          language: resolved.model.languageCode ? transcript?.language : undefined
        }
      : undefined
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open && !!op, [nonce, clone.saved])
  const card = useCardRun(() => setNonce((n) => n + 1))
  const blocked = resolved.missing ?? (resolved.needsConsent ? 'Tick that you have the right to use the voice.' : undefined)

  return (
    <OpCard title="New line" summary="A new line where the playhead is." open={open} onToggle={onToggle}>
      <Field label="What should be said?">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Wait! You forgot your keys."
          className={textArea}
        />
      </Field>
      <TimeAt label="Starts at" value={at} onChange={setAt} player={player} />
      <SpeechVoiceField value={voiceValue} onChange={setVoiceValue} resolved={resolved} onConsent={clone.setConsent} />
      <PlanNotes
        plan={plan}
        error={card.error ?? planError ?? clone.error}
        extraNotes={['The sound under the line is lowered while it plays.']}
      />
      <RunButton
        label="Add the line"
        plan={plan}
        planning={planning}
        running={card.running}
        approximate={resolved.model?.endpoint === 'speech'}
        disabled={!op || !!blocked}
        disabledReason={!text.trim() ? 'Write the line.' : blocked}
        onClick={() => plan && op && void card.run({ op, plan, label: 'New line' })}
      />
      {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
    </OpCard>
  )
}
