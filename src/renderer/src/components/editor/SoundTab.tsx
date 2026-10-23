import { useState } from 'react'
import type { EditOperation } from '@shared/types'
import { NO_SEPARATION } from '../../lib/hooks'
import { THIS_COMPUTER, isMac } from '../../lib/platform'
import { useOpenCard, useReportRange } from './cards'
import AddAudioDialog from './AddAudioDialog'
import { useCardRun, useEditor } from './EditorContext'
import { EffectCard, MusicCard } from './MusicTab'
import { Choice, Field, GainSlider, OpCard, PlanNotes, Target, actionButton } from './ui'

// Sound: free, local changes to the sound first, then the paid ones – new music and sound effects (MusicTab.tsx). The
// free ones make a new version with the picture copied as it is, so they take seconds and lose nothing; the voice and
// the background can be handled apart where this Mac can separate them (never on Windows: separation is Apple's).
// The tab says once that it is free; only the paid cards show a price, on their buttons.

export default function SoundTab() {
  const [open, toggle] = useOpenCard('ljud')
  const { separation } = useEditor()
  return (
    <div className="space-y-1">
      <p className="mx-3 mb-1 text-[11px] leading-relaxed text-muted">
        Free and runs on {THIS_COMPUTER} unless a price is shown.
      </p>
      {separation && !separation.available && (
        <p className="mx-3 mb-2 rounded-md border border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
          {separation.message ?? NO_SEPARATION} The voice and the background can’t be changed separately – everything
          else works.
        </p>
      )}
      <VolumeCard open={open === 'volume'} onToggle={() => toggle('volume')} />
      <MuteCard open={open === 'mute'} onToggle={() => toggle('mute')} />
      <CleanCard open={open === 'clean'} onToggle={() => toggle('clean')} />
      <AddCard open={open === 'add'} onToggle={() => toggle('add')} />
      <MusicCard open={open === 'music'} onToggle={() => toggle('music')} />
      <EffectCard open={open === 'effect'} onToggle={() => toggle('effect')} />
    </div>
  )
}

interface CardProps {
  open: boolean
  onToggle: () => void
}

type Scope = 'film' | 'range'
type Target3 = 'all' | 'voice' | 'background'

function ScopeChoice({ value, onChange }: { value: Scope; onChange: (s: Scope) => void }) {
  const { selection } = useEditor()
  return (
    <Choice
      value={selection ? value : 'film'}
      onChange={onChange}
      inline
      label="Applies to"
      options={[
        { value: 'film', label: 'The whole film' },
        {
          value: 'range',
          label: 'The selection',
          disabled: !selection,
          title: selection ? undefined : 'Mark a section on the timeline first'
        }
      ]}
    />
  )
}

function VolumeCard({ open, onToggle }: CardProps) {
  const { selection, separation } = useEditor()
  const [scope, setScope] = useState<Scope>('film')
  const [target, setTarget] = useState<Target3>('all')
  const [gain, setGain] = useState(-6)
  const card = useCardRun()
  const range = scope === 'range' ? selection : undefined
  useReportRange(open, range)
  const separated = !!separation?.available
  const what = separated ? target : 'all'

  const op: EditOperation = { op: 'volume', gainDb: gain, range, target: what }
  return (
    <OpCard title="Volume" summary="Raise or lower the sound, the voice or the background." open={open} onToggle={onToggle}>
      <ScopeChoice value={scope} onChange={setScope} />
      <Field label="What">
        <Choice
          value={what}
          onChange={setTarget}
          inline
          label="What"
          options={[
            { value: 'all', label: 'All sound' },
            { value: 'voice', label: 'The voice', disabled: !separated, title: separated ? undefined : NO_SEPARATION },
            { value: 'background', label: 'The background', disabled: !separated, title: separated ? undefined : NO_SEPARATION }
          ]}
        />
      </Field>
      <GainSlider value={gain} onChange={setGain} />
      <button
        type="button"
        disabled={card.running || gain === 0}
        onClick={() => void card.run({ op, label: 'Volume' })}
        className={`${actionButton} w-full`}
      >
        {card.running ? 'Creating version…' : 'Change the volume'}
      </button>
      <PlanNotes error={card.error} />
    </OpCard>
  )
}

function MuteCard({ open, onToggle }: CardProps) {
  const { selection, separation } = useEditor()
  const [scope, setScope] = useState<Scope>('film')
  const card = useCardRun()
  const [busy, setBusy] = useState<string>()
  const range = scope === 'range' ? selection : undefined
  useReportRange(open, selection)
  const separated = !!separation?.available

  const go = async (key: string, op: EditOperation, label: string) => {
    setBusy(key)
    await card.run({ op, label })
    setBusy(undefined)
  }

  return (
    <OpCard
      title="Mute and remove the voice"
      summary="Mute the selection, remove the voice or keep only the voice."
      open={open}
      onToggle={onToggle}
    >
      <div>
        <Target range={selection} whole="No selection" />
        <button
          type="button"
          disabled={!selection || !!busy}
          onClick={() => selection && void go('mute', { op: 'mute', range: selection, target: 'all' }, 'Mute the selection')}
          title={selection ? 'All sound in the selection is muted' : 'Mark a section on the timeline first'}
          className={`${actionButton} mt-2 w-full`}
        >
          {busy === 'mute' ? 'Creating version…' : 'Mute the selection'}
        </button>
      </div>
      <div className="space-y-2.5 border-t border-line pt-3">
        <ScopeChoice value={scope} onChange={setScope} />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!separated || !!busy}
            title={separated ? 'Music and effects stay' : NO_SEPARATION}
            onClick={() => void go('voice', { op: 'mute', range, target: 'voice' }, 'Remove the voice')}
            className={actionButton}
          >
            {busy === 'voice' ? 'Creating version…' : 'Remove the voice'}
          </button>
          <button
            type="button"
            disabled={!separated || !!busy}
            title={separated ? 'Music and effects are removed, the voice stays' : NO_SEPARATION}
            onClick={() => void go('background', { op: 'mute', range, target: 'background' }, 'Only the voice')}
            className={actionButton}
          >
            {busy === 'background' ? 'Creating version…' : 'Only the voice'}
          </button>
        </div>
        {(separated || isMac) && (
          <p className="text-[11px] leading-relaxed text-muted">
            The voice is separated from the background on {THIS_COMPUTER} – the first time takes a while for a long film.
          </p>
        )}
      </div>
      <PlanNotes error={card.error} />
    </OpCard>
  )
}

const LOUDNESS: { value: -14 | -16 | -23; label: string; hint: string }[] = [
  { value: -14, label: '−14 LUFS', hint: 'web and social media' },
  { value: -16, label: '−16 LUFS', hint: 'podcasts and streaming' },
  { value: -23, label: '−23 LUFS', hint: 'TV' }
]

function CleanCard({ open, onToggle }: CardProps) {
  const [strength, setStrength] = useState<'mild' | 'strong'>('mild')
  const [lufs, setLufs] = useState<-14 | -16 | -23>(-14)
  const card = useCardRun()
  const [busy, setBusy] = useState<string>()
  const go = async (key: string, op: EditOperation, label: string) => {
    setBusy(key)
    await card.run({ op, label })
    setBusy(undefined)
  }
  return (
    <OpCard
      title="Noise and loudness"
      summary="Remove noise and even out the loudness of the whole film."
      open={open}
      onToggle={onToggle}
    >
      <Field label="Remove noise">
        <div className="flex items-center gap-3">
          <Choice
            value={strength}
            onChange={setStrength}
            inline
            label="Strength"
            options={[
              { value: 'mild', label: 'Mild' },
              { value: 'strong', label: 'Strong' }
            ]}
          />
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void go('denoise', { op: 'denoise', strength }, 'Remove noise')}
            className={`${actionButton} ml-auto`}
          >
            {busy === 'denoise' ? 'Creating version…' : 'Remove noise'}
          </button>
        </div>
      </Field>
      <Field label="Even out the loudness">
        <Choice
          value={lufs}
          onChange={setLufs}
          label="Loudness"
          options={LOUDNESS.map((l) => ({ value: l.value, label: l.label, hint: l.hint }))}
        />
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void go('loudness', { op: 'loudness', lufs }, 'Even out the loudness')}
          className={`${actionButton} mt-2 w-full`}
        >
          {busy === 'loudness' ? 'Creating version…' : 'Even out the loudness'}
        </button>
      </Field>
      <PlanNotes error={card.error} />
    </OpCard>
  )
}

function AddCard({ open, onToggle }: CardProps) {
  const [dialog, setDialog] = useState<'add' | 'replace'>()
  return (
    <OpCard
      title="Add sound"
      summary="Your own music, a voice or a soundscape on top – or in place of the original sound."
      open={open}
      onToggle={onToggle}
    >
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setDialog('add')} className={actionButton}>
          Add sound…
        </button>
        <button type="button" onClick={() => setDialog('replace')} className={actionButton}>
          Replace the original…
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted">
        From the library (a voice or a soundscape), from earlier sound in this edit, or from a file of your own. It
        lands as a layer on the timeline.
      </p>
      {dialog && <AddAudioDialog replace={dialog === 'replace'} onClose={() => setDialog(undefined)} />}
    </OpCard>
  )
}
