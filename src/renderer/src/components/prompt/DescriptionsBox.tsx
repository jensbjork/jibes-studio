import { useId, useState } from 'react'
import type { Asset } from '@shared/types'
import AssetAvatar from '../assets/AssetAvatar'
import { KIND_TONE } from '../pickers/assetKinds'
import type { DescriptionRow, DescriptionsView } from './descriptions'

interface Props {
  /**
   * descriptionsView of the form's params, the live library (a description edited there shows up here at once, and
   * is what main sends), the prompt language and the model's prompt limit. The form computes it once: its prompt
   * checks need to know which references the legend explains.
   */
  view: DescriptionsView
  /** The master switch, "Ta med beskrivningar" (includeDescriptions). */
  onInclude: (on: boolean) => void
  /** One asset's toggle (excludedDescriptionAssetIds). */
  onToggle: (assetId: string, on: boolean) => void
  /** "Ändra beskrivning": opens the asset in its library view. */
  onOpenAsset?: (asset: Asset) => void
}

/**
 * "Läggs till i prompten": the descriptions of the characters, places, outfits and poses among the references,
 * which are appended to the prompt as a References legend when it is sent (composed by main from the library as
 * it is then, so an edited description applies to the next generation), with who wears each outfit. One row per
 * described asset (and per outfit somebody wears) with its tokens and an excerpt, a toggle for each and a master
 * switch, a link to edit the description, and the length of the prompt as sent against the model's limit, with a
 * note when descriptions had to be shortened or left out to fit. Hidden while no reference that is sent has a
 * description and no outfit is worn.
 */
export default function DescriptionsBox({ view, onInclude, onToggle, onOpenAsset }: Props) {
  const [showText, setShowText] = useState(false)
  const titleId = useId()
  const textId = useId()
  const { rows, undescribed, include, composed, blank, truncated, dropped, limit } = view
  if (!rows.length) return null

  const length = composed.prompt.length
  const over = limit !== undefined && length > limit
  const sent = rows.filter((r) => r.sent).length
  const legend = composed.legend.replace(/^\s+/, '')
  const note = !include
    ? { tone: 'text-muted', text: 'Beskrivningarna skickas inte.' }
    : dropped
      ? {
          tone: 'text-accent',
          text:
            `Beskrivningarna får inte plats inom modellens gräns på ${limit} tecken och skickas inte. ` +
            'Korta prompten eller slå av några av dem.'
        }
      : !sent
        ? { tone: 'text-muted', text: 'Inga beskrivningar skickas.' }
        : blank
          ? { tone: 'text-muted', text: 'Läggs till efter prompten när du har skrivit den.' }
          : truncated
            ? {
                tone: 'text-amber-300',
                text: `Beskrivningarna har kortats så att prompten ryms inom modellens gräns på ${limit} tecken.`
              }
            : { tone: 'text-muted', text: 'Skickas efter prompten, som en lista över referenserna.' }

  return (
    <section aria-labelledby={titleId} className="mt-3 overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line/60 px-2.5 py-1.5">
        <h4 id={titleId} className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted">
          Läggs till i prompten
        </h4>
        <button
          type="button"
          role="switch"
          aria-checked={include}
          onClick={() => onInclude(!include)}
          title={
            include
              ? 'Beskrivningarna av referenserna läggs till efter prompten när den skickas'
              : 'Lägg till beskrivningarna av referenserna efter prompten när den skickas'
          }
          className="flex shrink-0 items-center gap-1.5 rounded text-[11px] text-muted transition hover:text-text"
        >
          Ta med beskrivningar
          <Track on={include} />
        </button>
      </div>

      <ul className="divide-y divide-line/60">
        {rows.map((row) => (
          <Row
            key={row.asset.id}
            row={row}
            include={include}
            onToggle={(on) => onToggle(row.asset.id, on)}
            onOpen={onOpenAsset && (() => onOpenAsset(row.asset))}
          />
        ))}
      </ul>

      {undescribed.length > 0 && (
        <p className="border-t border-line/60 px-2.5 py-1.5 text-[11px] leading-snug text-muted">
          Utan beskrivning:{' '}
          {undescribed.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ', '}
              {onOpenAsset ? (
                <button
                  type="button"
                  onClick={() => onOpenAsset(a)}
                  title={`Skriv en beskrivning av ${a.name}`}
                  className="text-text hover:underline"
                >
                  {a.name}
                </button>
              ) : (
                a.name
              )}
            </span>
          ))}
        </p>
      )}

      <div className="flex items-start gap-3 border-t border-line/60 px-2.5 py-1.5 text-[11px] leading-snug">
        <span className={`min-w-0 flex-1 ${note.tone}`}>
          <span aria-live="polite">{note.text}</span>
          {legend && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => setShowText((s) => !s)}
                aria-expanded={showText}
                aria-controls={textId}
                className="whitespace-nowrap text-text hover:underline"
              >
                {showText ? 'Dölj texten' : 'Visa texten'}
              </button>
            </>
          )}
        </span>
        {/* The length of the prompt as it is sent; nothing is sent while the prompt is blank. */}
        {!blank && (
          <span
            className={`shrink-0 tabular-nums ${over ? 'text-accent' : 'text-muted'}`}
            title={
              limit
                ? `Prompten som skickas, med beskrivningarna: ${length} av högst ${limit} tecken`
                : `Prompten som skickas, med beskrivningarna: ${length} tecken`
            }
          >
            {limit ? `${length}/${limit}` : `${length} tecken`}
          </span>
        )}
      </div>

      {legend && showText && (
        <p
          id={textId}
          className="max-h-40 overflow-y-auto border-t border-line/60 bg-raised/60 px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted select-text"
        >
          <LegendText text={legend} rows={rows} />
        </p>
      )}
    </section>
  )
}

function Row({
  row,
  include,
  onToggle,
  onOpen
}: {
  row: DescriptionRow
  include: boolean
  onToggle: (on: boolean) => void
  onOpen?: () => void
}) {
  const { asset, tokens, description, wornBy, on, sent, shortened } = row
  const tone = KIND_TONE[asset.kind]
  return (
    <li className="flex items-start gap-2 px-2.5 py-2">
      <AssetAvatar asset={asset} className={`h-7 w-7 rounded ${sent ? '' : 'opacity-45'}`} />
      <div className={`min-w-0 flex-1 ${sent ? '' : 'opacity-55'}`}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] leading-snug">
          <span className={`min-w-0 truncate font-medium ${tone.text}`}>{asset.name}</span>
          {tokens.map((token) => (
            <span
              key={token}
              className={`rounded-[3px] px-0.5 text-[11px] ${tone.token} ${
                token.startsWith('@Audio') ? 'underline decoration-current/60 decoration-dotted underline-offset-[3px]' : ''
              }`}
            >
              {token}
            </span>
          ))}
          {/* Who wears the outfit, as the legend says it ("worn by Anna (@Image1)"); chosen on its chip (bärs av). */}
          {wornBy && (
            <span className="text-[11px] text-muted" title={`${asset.name} bärs av ${wornBy.asset.name} – det skrivs in i prompten`}>
              bärs av <span className={KIND_TONE[wornBy.asset.kind].text}>{wornBy.asset.name}</span>
              {wornBy.tokens.length > 0 && ` (${wornBy.tokens.join(', ')})`}
            </span>
          )}
        </div>
        {/* What is sent: the shortened text when the model's limit asked for it, the full one otherwise (and,
            dimmed with the row, while it isn't sent at all). A worn outfit without a description sends who wears it. */}
        {description ? (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted select-text" title={description}>
            {shortened || description}
          </p>
        ) : (
          <p className="mt-0.5 text-[11px] leading-snug text-muted">Ingen beskrivning – bara vem som bär den.</p>
        )}
        {(shortened !== undefined || onOpen) && (
          <div className="mt-0.5 flex items-center gap-2 text-[11px]">
            {shortened !== undefined && (
              <span
                className="text-amber-300"
                title={
                  shortened
                    ? `Kortad för att rymmas inom modellens gräns. Hela beskrivningen: ${description}`
                    : 'Får inte plats inom modellens gräns – bara namnet och referenserna skickas'
                }
              >
                {shortened ? 'förkortad' : 'utelämnad'}
              </span>
            )}
            {onOpen && (
              <button
                type="button"
                onClick={onOpen}
                title={`Öppna ${asset.name} i biblioteket`}
                className="text-muted transition hover:text-text hover:underline"
              >
                {description ? 'Ändra beskrivning' : 'Skriv en beskrivning'}
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={description ? `Ta med beskrivningen av ${asset.name}` : `Ta med vem som bär ${asset.name}`}
        disabled={!include}
        onClick={() => onToggle(!on)}
        title={
          !include
            ? 'Beskrivningarna är avslagna'
            : on
              ? `${description ? `Beskrivningen av ${asset.name}` : `Vem som bär ${asset.name}`} läggs till – klicka för att låta bli`
              : `Lägg till ${description ? `beskrivningen av ${asset.name}` : `vem som bär ${asset.name}`}`
        }
        className="mt-1 shrink-0 rounded-full disabled:opacity-40"
      >
        <Track on={on} />
      </button>
    </li>
  )
}

/** The legend as it is sent, its tokens coloured like the assets they belong to (as in the prompt above). */
function LegendText({ text, rows }: { text: string; rows: readonly DescriptionRow[] }) {
  const tones = new Map(
    rows.flatMap((r) => [
      // A wearer without a row of its own (no description) is named in its outfit's line.
      ...(r.wornBy?.tokens.map((t) => [t, KIND_TONE[r.wornBy!.asset.kind].token] as const) ?? []),
      ...r.tokens.map((t) => [t, KIND_TONE[r.asset.kind].token] as const)
    ])
  )
  // split() with a capturing group puts the tokens at the odd indices.
  return (
    <>
      {text.split(/(@(?:Image|Audio)\d+)/g).map((part, i) =>
        i % 2 ? (
          <span key={i} className={`rounded-[3px] ${tones.get(part) ?? 'text-text'}`}>
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  )
}

/** A small switch track, the app's switches at the size of the box's text. */
function Track({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`relative block h-4 w-7 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-line'}`}>
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left] ${on ? 'left-[14px]' : 'left-0.5'}`}
      />
    </span>
  )
}
