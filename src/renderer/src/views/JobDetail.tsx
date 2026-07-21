import { useEffect, useState } from 'react'
import {
  Bookmark,
  Building2,
  Check,
  ExternalLink,
  Loader2,
  Lock,
  MapPin,
  Minus,
  Send,
  TrendingDown,
  TrendingUp,
  X
} from 'lucide-react'
import type { AuthState, Job, Resume, SalaryInsight } from '../../../shared/types'
import { isStale, money, publishedLine, salaryLabel, workModeLabel } from '../lib/format'
import Confirm from './Confirm'

interface Props {
  job: Job
  auth: AuthState
  staleAfterDays: number
  onClose: () => void
}

export default function JobDetail({ job: initial, auth, staleAfterDays, onClose }: Props): JSX.Element {
  const [job, setJob] = useState<Job>(initial)
  const [insight, setInsight] = useState<SalaryInsight | null>(null)
  const [resumes, setResumes] = useState<Resume[]>([])
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [loadingBody, setLoadingBody] = useState(!initial.description)
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)
  const [askExternal, setAskExternal] = useState(false)
  const [saved, setSaved] = useState(false)

  // Pull the full description on open — the feed only carries a snippet.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const full = await window.seekr.job.detail(initial.id)
      if (!cancelled && full) setJob(full)
      if (!cancelled) setLoadingBody(false)
    })()
    return () => {
      cancelled = true
    }
  }, [initial.id])

  useEffect(() => {
    if (!job.salary) return
    void window.seekr.salary.insight(job.id).then(setInsight)
  }, [job.id, job.salary])

  useEffect(() => {
    if (!auth.loggedIn) return
    void window.seekr.resumes.list().then((list) => {
      setResumes(list)
      setResumeId(list[0]?.id ?? null)
    })
  }, [auth.loggedIn])

  useEffect(() => {
    void window.seekr.saved.ids().then((ids) => setSaved(ids.includes(initial.id)))
  }, [initial.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stale = isStale(job, staleAfterDays)
  const salary = salaryLabel(job.salary)
  const verdict = job.workMode

  const handleApply = async (): Promise<void> => {
    setApplying(true)
    try {
      const result = await window.seekr.applications.apply(job.id, resumeId)
      if (result.record) {
        setApplied(true)
      } else if (result.askedExternal) {
        // Indeed handed off to the company's own site, so we can't tell whether it
        // was finished. Ask in our own dialog rather than a native Windows box.
        setAskExternal(true)
      }
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-title" style={{ fontSize: 'var(--text-lg)' }}>
              {job.title}
            </div>
          </div>
          <button className="btn icon ghost" onClick={onClose} data-tip="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="detail-head">
            <div className="job-meta" style={{ marginTop: 0 }}>
              <span>
                <Building2 size={13} />
                {job.company}
              </span>
              <span>
                <MapPin size={13} />
                {job.location || 'Location not stated'}
              </span>
              <span className={`tag ${verdict.mode === 'remote' ? 'remote' : verdict.mode === 'hybrid' ? 'hybrid' : ''}`}>
                {workModeLabel(job)}
              </span>
              {salary && <span className="tag salary">{salary}</span>}
            </div>

            {/* Date Reveal, in full: exact publication date and how long ago. */}
            <div
              className={stale ? 'banner warn' : 'field-hint'}
              style={{ marginTop: 'var(--s3)', marginBottom: 0 }}
            >
              {publishedLine(job)}
              {stale && ` — over ${staleAfterDays} days old, so it may already be filled.`}
            </div>

            {/* Salary comparison against Seekr's own corpus. */}
            {insight && (
              <div style={{ marginTop: 'var(--s3)' }}>
                {insight.percentDiff !== null ? (
                  <span
                    className={`insight ${insight.percentDiff > 4 ? 'above' : insight.percentDiff < -4 ? 'below' : ''}`}
                  >
                    {insight.percentDiff > 4 ? (
                      <TrendingUp size={12} />
                    ) : insight.percentDiff < -4 ? (
                      <TrendingDown size={12} />
                    ) : (
                      <Minus size={12} />
                    )}
                    {insight.label}
                    {insight.median !== null &&
                      ` · median ${money(insight.median, insight.currency)} across ${insight.sampleSize} similar roles`}
                  </span>
                ) : (
                  <span className="field-hint">
                    Not enough comparable listings yet to judge this salary — Seekr needs a few more
                    similar roles in this region first.
                  </span>
                )}
              </div>
            )}

            {/* Why the classifier called it what it called it. */}
            {(verdict.positives.length > 0 || verdict.negatives.length > 0) && (
              <div className="reasons">
                {verdict.positives.map((reason) => (
                  <div className="reason pos" key={reason}>
                    <Check size={11} /> {reason}
                  </div>
                ))}
                {verdict.negatives.map((reason) => (
                  <div className="reason neg" key={reason}>
                    <Minus size={11} /> {reason}
                  </div>
                ))}
              </div>
            )}
          </div>

          {loadingBody ? (
            <div style={{ display: 'flex', gap: 8, color: 'var(--fg-subtle)', fontSize: 'var(--text-sm)' }}>
              <Loader2 size={14} className="spin" />
              Loading the full description from Indeed…
            </div>
          ) : (
            <div className="detail-body">
              {job.description || job.snippet || 'Indeed did not provide a description for this listing.'}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button
            className={`btn ${saved ? '' : 'ghost'}`}
            onClick={async () => {
              const result = await window.seekr.saved.toggle(job.id)
              setSaved(result.saved)
            }}
          >
            <Bookmark size={14} fill={saved ? 'currentColor' : 'none'} />
            {saved ? 'Saved' : 'Save'}
          </button>

          <button className="btn ghost" onClick={() => void window.seekr.job.open(job.id)}>
            <ExternalLink size={14} />
            View on Indeed
          </button>

          <div className="spacer" />

          {/* Applying is the one thing that genuinely requires a login. */}
          {!auth.loggedIn ? (
            <button className="btn primary" onClick={() => void window.seekr.auth.login()}>
              <Lock size={14} />
              Sign in to apply
            </button>
          ) : applied ? (
            <span className="status-pill">
              <Check size={12} />
              Added to your applications
            </span>
          ) : (
            <>
              {resumes.length > 0 && (
                <select
                  className="status-select"
                  value={resumeId ?? ''}
                  onChange={(e) => setResumeId(e.target.value || null)}
                  data-tip="Which resume to use"
                >
                  {resumes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </select>
              )}
              <button className="btn primary" onClick={() => void handleApply()} disabled={applying}>
                {applying ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                {applying ? 'Apply window open…' : 'Apply'}
              </button>
            </>
          )}
        </div>
      </div>

      {askExternal && (
        <Confirm
          title="Did you apply?"
          message="That application continued on the company's own website, so Seekr can't see whether you finished it. Add it to your applications?"
          confirmLabel="Yes, log it"
          cancelLabel="No"
          onCancel={() => setAskExternal(false)}
          onConfirm={async () => {
            await window.seekr.applications.track(job.id, resumeId)
            setAskExternal(false)
            setApplied(true)
          }}
        />
      )}
    </div>
  )
}
