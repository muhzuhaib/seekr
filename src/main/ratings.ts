/**
 * What Indeed says each company is rated, remembered by company rather than by
 * listing.
 *
 * Ratings arrived in v0.4.1, so every listing cached before that has none — and
 * because those listings already have their descriptions, nothing ever re-fetches
 * them. The feed was therefore full of big, obviously-rated employers showing no
 * rating at all, and would have stayed that way until the listings aged out.
 *
 * A rating is a property of the company, not of the advert, so it only has to be
 * looked up once per employer, ever. `null` is a real answer here — it means
 * "checked, Indeed has no rating for them" — and it is what stops Seekr asking
 * again about the corner shop with no reviews.
 */

import { createStore } from './store'

interface RatingsFile {
  /** company key → rating, or null for "checked, they have none". */
  companies: Record<string, number | null>
}

const store = createStore<RatingsFile>('ratings.json', { companies: {} })
const known = new Map<string, number | null>(Object.entries(store.get().companies))

/**
 * Exact, case- and space-insensitive. Fuzzier matching would eventually put one
 * company's score on another's listing, which is worse than a missing star.
 */
export function companyKey(company: string): string {
  return company.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function ratingFor(company: string): number | null {
  return known.get(companyKey(company)) ?? null
}

/** True once we have an answer — including "they have no rating". */
export function isChecked(company: string): boolean {
  return known.has(companyKey(company))
}

export function remember(company: string, rating: number | null): void {
  const key = companyKey(company)
  if (!key) return
  // Never let a "no rating" answer overwrite a real one we already have.
  if (rating === null && known.get(key)) return
  if (known.get(key) === rating) return
  known.set(key, rating)
  persist()
}

/** Bulk-learn from listings that arrived carrying a rating. */
export function rememberAll(pairs: { company: string; rating: number | null }[]): void {
  let changed = false
  for (const { company, rating } of pairs) {
    const key = companyKey(company)
    if (!key || rating === null) continue
    if (known.get(key) === rating) continue
    known.set(key, rating)
    changed = true
  }
  if (changed) persist()
}

function persist(): void {
  store.set({ companies: Object.fromEntries(known) })
}

export function knownCount(): number {
  return known.size
}
