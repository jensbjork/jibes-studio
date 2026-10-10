// Grades: the user's rating of a clip and the rating in an agent's review are both tumme ner (-1) or one to three
// stars (see RatingValue). How Studio checks and says them, for main, the agent tools and the renderer alike. Pure
// (no Node or DOM), like everything in src/shared.

import { RATING_VALUES, THUMBS_DOWN, type RatingValue } from './types'

/** Whether a value is a grade: -1 (tumme ner), 1, 2 or 3 (stars). */
export function isRatingValue(value: unknown): value is RatingValue {
  return typeof value === 'number' && (RATING_VALUES as readonly number[]).includes(value)
}

/** The stars of a grade: 0 for tumme ner and for no grade. */
export function starCount(rating: number | null | undefined): number {
  return isRatingValue(rating) && rating !== THUMBS_DOWN ? rating : 0
}

/** "Tumme ner", "1 stjärna", "2 stjärnor", "3 stjärnor", or "Inte betygsatt" without a grade. */
export function ratingLabel(rating: number | null | undefined): string {
  if (rating === THUMBS_DOWN) return 'Tumme ner'
  if (!isRatingValue(rating)) return 'Inte betygsatt'
  return rating === 1 ? '1 stjärna' : `${rating} stjärnor`
}
