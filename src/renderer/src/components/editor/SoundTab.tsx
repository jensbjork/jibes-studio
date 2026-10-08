import { useState } from 'react'
import type { EditOperation } from '@shared/types'
import { useOpenCard, useReportRange } from './cards'
import AddAudioDialog from './AddAudioDialog'
import { useCardRun, useEditor } from './EditorContext'
import { Choice, CostTag, Field, GainSlider, OpCard, PlanNotes, Target } from './ui'

// Ljud: free, local changes to the sound. Each makes a new version with the picture copied as it is, so they take
// seconds and lose nothing; the voice and the background can be handled apart where this Mac can separate them.

const NO_SEPARATION = 'Röstseparering saknas på den här datorn.'

const actionButton =
  'rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'

export default function SoundTab() {
  const [open, toggle] = useOpenCard('ljud')
  const { separation } = useEditor()
  return (
    <div className="space-y-1">
      {separation && !separation.available && (
        <p className="mx-3 mb-2 rounded-md border border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
          {separation.message ?? NO_SEPARATION} Rösten och bakgrunden kan inte ändras var för sig – allt annat
          fungerar.
        </p>
      )}
      <VolumeCard open={open === 'volume'} onToggle={() => toggle('volume')} />
      <MuteCard open={open === 'mute'} onToggle={() => toggle('mute')} />
      <CleanCard open={open === 'clean'} onToggle={() => toggle('clean')} />
      <AddCard open={open === 'add'} onToggle={() => toggle('add')} />
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
      label="Gäller"
      options={[
        { value: 'film', label: 'Hela filmen' },
        {
          value: 'range',
          label: 'Markeringen',
          disabled: !selection,
          title: selection ? undefined : 'Markera ett avsnitt på tidslinjen först'
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
    <OpCard title="Volym" summary="Höj eller sänk ljudet, rösten eller bakgrunden." badge={<CostTag paid={false} />} open={open} onToggle={onToggle}>
      <ScopeChoice value={scope} onChange={setScope} />
      <Field label="Vad">
        <Choice
          value={what}
          onChange={setTarget}
          inline
          label="Vad"
          options={[
            { value: 'all', label: 'Allt ljud' },
            { value: 'voice', label: 'Rösten', disabled: !separated, title: separated ? undefined : NO_SEPARATION },
            { value: 'background', label: 'Bakgrunden', disabled: !separated, title: separated ? undefined : NO_SEPARATION }
          ]}
        />
      </Field>
      <GainSlider value={gain} onChange={setGain} />
      <button
        type="button"
        disabled={card.running || gain === 0}
        onClick={() => void card.run({ op, label: 'Volym' })}
        className={`${actionButton} w-full`}
      >
        {card.running ? 'Skapar version…' : 'Ändra volymen'}
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
      title="Tysta och ta bort rösten"
      summary="Tysta markeringen, ta bort rösten eller behåll bara den."
      badge={<CostTag paid={false} />}
      open={open}
      onToggle={onToggle}
    >
      <div>
        <Target range={selection} whole="Ingen markering" />
        <button
          type="button"
          disabled={!selection || !!busy}
          onClick={() => selection && void go('mute', { op: 'mute', range: selection, target: 'all' }, 'Tysta markeringen')}
          title={selection ? 'Allt ljud i markeringen tystas' : 'Markera ett avsnitt på tidslinjen först'}
          className={`${actionButton} mt-2 w-full`}
        >
          {busy === 'mute' ? 'Skapar version…' : 'Tysta markeringen'}
        </button>
      </div>
      <div className="space-y-2.5 border-t border-line pt-3">
        <ScopeChoice value={scope} onChange={setScope} />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!separated || !!busy}
            title={separated ? 'Musik och effekter blir kvar' : NO_SEPARATION}
            onClick={() => void go('voice', { op: 'mute', range, target: 'voice' }, 'Ta bort rösten')}
            className={actionButton}
          >
            {busy === 'voice' ? 'Skapar version…' : 'Ta bort rösten'}
          </button>
          <button
            type="button"
            disabled={!separated || !!busy}
            title={separated ? 'Musik och effekter tas bort, rösten blir kvar' : NO_SEPARATION}
            onClick={() => void go('background', { op: 'mute', range, target: 'background' }, 'Bara rösten')}
            className={actionButton}
          >
            {busy === 'background' ? 'Skapar version…' : 'Bara rösten'}
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          Rösten skiljs från bakgrunden på datorn – första gången tar det en stund för en lång film.
        </p>
      </div>
      <PlanNotes error={card.error} />
    </OpCard>
  )
}

const LOUDNESS: { value: -14 | -16 | -23; label: string; hint: string }[] = [
  { value: -14, label: '−14 LUFS', hint: 'webb och sociala medier' },
  { value: -16, label: '−16 LUFS', hint: 'poddar och strömning' },
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
      title="Brus och ljudnivå"
      summary="Ta bort brus och jämna ut ljudnivån i hela filmen."
      badge={<CostTag paid={false} />}
      open={open}
      onToggle={onToggle}
    >
      <Field label="Ta bort brus">
        <div className="flex items-center gap-3">
          <Choice
            value={strength}
            onChange={setStrength}
            inline
            label="Styrka"
            options={[
              { value: 'mild', label: 'Mild' },
              { value: 'strong', label: 'Stark' }
            ]}
          />
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void go('denoise', { op: 'denoise', strength }, 'Ta bort brus')}
            className={`${actionButton} ml-auto`}
          >
            {busy === 'denoise' ? 'Skapar version…' : 'Ta bort brus'}
          </button>
        </div>
      </Field>
      <Field label="Jämna ut ljudnivån">
        <Choice
          value={lufs}
          onChange={setLufs}
          label="Ljudnivå"
          options={LOUDNESS.map((l) => ({ value: l.value, label: l.label, hint: l.hint }))}
        />
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void go('loudness', { op: 'loudness', lufs }, 'Jämna ut ljudnivån')}
          className={`${actionButton} mt-2 w-full`}
        >
          {busy === 'loudness' ? 'Skapar version…' : 'Jämna ut ljudnivån'}
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
      title="Lägg till ljud"
      summary="Musik, en röst eller en ljudmiljö ovanpå – eller i stället för originalljudet."
      badge={<CostTag paid={false} />}
      open={open}
      onToggle={onToggle}
    >
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setDialog('add')} className={actionButton}>
          Lägg till ljud…
        </button>
        <button type="button" onClick={() => setDialog('replace')} className={actionButton}>
          Ersätt originalljudet…
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted">
        Från biblioteket (en röst eller ljudmiljö), från tidigare ljud i den här redigeringen, eller från en egen fil.
        Det hamnar som ett lager på tidslinjen.
      </p>
      {dialog && <AddAudioDialog replace={dialog === 'replace'} onClose={() => setDialog(undefined)} />}
    </OpCard>
  )
}
