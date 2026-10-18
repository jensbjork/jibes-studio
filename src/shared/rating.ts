// Grades: the user's rating of a clip and the rating in an agent's review are both thumbs down (-1) or one to three
// stars (see RatingValue). How Studio checks and says them, for main, the agent tools and the renderer alike. Pure
// (no Node or DOM), like everything in src/shared.

import { RATING_VALUES, THUMBS_DOWN, type RatingValue } from './types'

/** Whether a value is a grade: -1 (thumbs down), 1, 2 or 3 (stars). */
export function isRatingValue(value: unknown): value is RatingValue {
  return typeof value === 'number' && (RATING_VALUES as readonly number[]).includes(value)
}

/** The stars of a grade: 0 for thumbs down and for no grade. */
export function starCount(rating: number | null | undefined): number {
  return isRatingValue(rating) && rating !== THUMBS_DOWN ? rating : 0
}

/** "Thumbs down", "1 star", "2 stars", "3 stars", or "Not rated" without a grade. */
export function ratingLabel(rating: number | null | undefined): string {
  if (rating === THUMBS_DOWN) return 'Thumbs down'
  if (!isRatingValue(rating)) return 'Not rated'
  return rating === 1 ? '1 star' : `${rating} stars`
}
