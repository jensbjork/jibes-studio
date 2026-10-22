import { INSTALLED_APP } from '../lib/platform'

/** Marks the development version ("Studio Dev") so it can't be mistaken for JIBES Studio.app. */
export default function DevBadge() {
  return (
    <span
      className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-amber-300"
      title={`The development version – its own settings and library, separate from ${INSTALLED_APP}`}
    >
      Dev
    </span>
  )
}

/** Marks a variant ("Test" for Studio Test) so it can't be mistaken for JIBES Studio.app either. */
export function VariantBadge({ name }: { name: string }) {
  return (
    <span
      className="rounded bg-rose-400/15 px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-rose-300"
      title={`Studio ${name} – its own settings and library, separate from ${INSTALLED_APP}`}
    >
      {name}
    </span>
  )
}
