import { createPortal } from 'react-dom'
import type { SwitchPhase } from './useLibrarySwitch'

/** Covers the whole window while the library is switched; nothing else may run against it meanwhile. */
export default function SwitchingOverlay({ phase }: { phase: SwitchPhase }) {
  if (phase.kind === 'idle') return null
  const moving = phase.kind === 'working' && phase.mode === 'move'
  const title = moving ? 'Flyttar biblioteket…' : 'Byter bibliotek…'

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-[60] flex flex-col bg-bg/95"
      role="alertdialog"
      aria-label={title}
      aria-busy="true"
      aria-live="polite"
    >
      <div className="drag h-12 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-8 pb-20">
        <div className="max-w-sm text-center">
          <span className="mx-auto mb-5 block h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-2 leading-relaxed text-muted">
            {phase.kind === 'reloading'
              ? 'Klart. Studio öppnar biblioteket i den nya mappen.'
              : phase.kind === 'waiting'
                ? 'Biblioteket byts eller flyttas just nu. Studio fortsätter när det är klart – stäng inte appen under tiden.'
                : moving
                ? 'Filerna flyttas till den nya mappen. Stäng inte Studio under tiden – med många videor kan det ta en stund.'
                : 'Ett ögonblick.'}
          </p>
        </div>
      </div>
    </div>,
    document.body
  )
}
