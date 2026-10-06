/** Marks the development version ("Studio Dev") so it can't be mistaken for Studio.app. */
export default function DevBadge() {
  return (
    <span
      className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-amber-300"
      title="Utvecklingsversionen – egna inställningar och eget bibliotek, skilt från Studio.app"
    >
      Dev
    </span>
  )
}
