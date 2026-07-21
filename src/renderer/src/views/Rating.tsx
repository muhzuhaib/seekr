import { Star } from 'lucide-react'

/**
 * A company's Indeed star rating, shown beside their name.
 *
 * Renders nothing at all when there is no rating — plenty of small employers have
 * never been reviewed, and an empty or zero star would read as a bad score rather
 * than as no score. The review count is deliberately left out: the number on its
 * own is what you actually judge a company by at a glance.
 */
export default function Rating({ value }: { value: number | null }): JSX.Element | null {
  if (!value || value <= 0) return null

  return (
    <span
      className="rating"
      data-tip={`Employees rate this company ${value.toFixed(1)} out of 5 on Indeed`}
    >
      <Star size={11} fill="currentColor" strokeWidth={0} />
      {value.toFixed(1)}
    </span>
  )
}
