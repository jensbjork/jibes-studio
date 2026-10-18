// Variants: several takes of the same settings sent at once (Generate, a sequence clip, a storyboard transition, and
// an agent's request for one of them). Each variant is its own generation – Venice picks a new seed each time – and
// costs the full price, so the price shown and checked against the budget is the price of one times the count.

/** The counts offered (GenerateOptions.count). */
export const VARIANT_COUNTS = [1, 2, 3, 4] as const

export const MAX_VARIANTS = VARIANT_COUNTS[VARIANT_COUNTS.length - 1]

/** A whole number of variants Studio sends at once: 1–4. */
export function isVariantCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_VARIANTS
}

/**
 * The count a GenerateOptions asks for: 1 without one. Throws for anything but a whole number 1–4, so a wrong count
 * never quietly sends something else than was asked for (and paid).
 */
export function variantCountOf(opts: unknown): number {
  const count = opts && typeof opts === 'object' ? (opts as { count?: unknown }).count : undefined
  if (count === undefined || count === null) return 1
  if (!isVariantCount(count)) throw new Error(`Choose 1–${MAX_VARIANTS} variants.`)
  return count
}

/** What `count` variants cost together; undefined when the price of one is unknown. */
export function variantsPrice(each: number | undefined, count: number): number | undefined {
  return each === undefined ? undefined : each * count
}

/** "1 variant", "3 variants". */
export function variantsText(count: number): string {
  return `${count} ${count === 1 ? 'variant' : 'variants'}`
}

/** "2nd", "3rd": which variant, in a sentence about the one that failed. */
export function variantOrdinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`
}
