import { useEffect, useRef } from 'react'
import {
  Bookmark,
  Building2,
  Clock,
  MapPin,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap
} from 'lucide-react'
import type { Job, SalaryInsight } from '../../../shared/types'
import { isStale, publishedShort, salaryLabel, workModeLabel } from '../lib/format'

interface Props {
  job: Job
  insight?: SalaryInsight
  staleAfterDays: number
  selected: boolean
  onOpen: (job: Job) => void
  /** Whether this job is bookmarked. Omit to hide the bookmark control entirely. */
  saved?: boolean
  onToggleSave?: (job: Job) => void
}

export default function JobCard({
  job,
  insight,
  staleAfterDays,
  selected,
  onOpen,
  saved,
  onToggleSave
}: Props): JSX.Element {
  const stale = isStale(job, staleAfterDays)
  const salary = salaryLabel(job.salary)
  const mode = job.workMode.mode

  /*
    Hover-intent prefetch. Resting the pointer on a card for a moment starts
    fetching its description, so the click that follows usually opens instantly
    instead of waiting on the network. The delay keeps a pointer sweeping across
    the list from firing off a request per card.
  */
  const hoverTimer = useRef<number | null>(null)

  const startPrefetch = (): void => {
    if (job.description || hoverTimer.current !== null) return
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      void window.seekr.job.prefetch(job.id)
    }, 140)
  }

  const cancelPrefetch = (): void => {
    if (hoverTimer.current === null) return
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }

  useEffect(() => cancelPrefetch, [])

  return (
    <article
      className={`job-card ${stale ? 'stale' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onOpen(job)}
      onMouseEnter={startPrefetch}
      onMouseLeave={cancelPrefetch}
      onFocus={startPrefetch}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(job)
        }
      }}
      data-tip={stale ? `Posted over ${staleAfterDays} days ago — this may no longer be open` : undefined}
    >
      <div className="job-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 className="job-title">{job.title}</h3>
          <div className="job-company">
            <Building2 size={13} />
            {job.company || 'Unnamed company'}
          </div>
        </div>

        {onToggleSave && (
          <button
            className={`bookmark ${saved ? 'on' : ''}`}
            data-tip={saved ? 'Remove from saved' : 'Save this job'}
            onClick={(e) => {
              // The whole card is a button; without this, saving would also open it.
              e.stopPropagation()
              onToggleSave(job)
            }}
          >
            <Bookmark size={16} fill={saved ? 'currentColor' : 'none'} />
          </button>
        )}

        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {job.urgentlyHiring && (
            <span className="tag hot">
              <Zap size={11} />
              Urgent
            </span>
          )}
          {mode !== 'unknown' && (
            <span className={`tag ${mode === 'remote' ? 'remote' : mode === 'hybrid' ? 'hybrid' : ''}`}>
              {workModeLabel(job)}
            </span>
          )}
        </div>
      </div>

      <div className="job-meta">
        <span>
          <MapPin size={13} />
          {job.location || 'Location not stated'}
        </span>

        {/* Date Reveal — always the exact date plus how long ago, on every listing. */}
        <span className={stale ? 'tag stale' : undefined}>
          <Clock size={13} />
          {publishedShort(job)}
        </span>

        {salary && (
          <span className="tag salary">
            <Wallet size={11} />
            {salary}
          </span>
        )}

        {/* Salary comparison, shown only when the corpus has a real sample behind it. */}
        {insight && insight.percentDiff !== null && (
          <span
            className={`insight ${insight.percentDiff > 4 ? 'above' : insight.percentDiff < -4 ? 'below' : ''}`}
            data-tip={`Compared against ${insight.sampleSize} similar listings Seekr has seen in this region`}
          >
            {insight.percentDiff > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {insight.label}
          </span>
        )}
      </div>

      {job.snippet && <p className="job-snippet">{job.snippet}</p>}
    </article>
  )
}
