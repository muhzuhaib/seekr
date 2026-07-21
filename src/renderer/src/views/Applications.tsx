import { useCallback, useEffect, useState } from 'react'
import {
  Bell,
  ClipboardList,
  ExternalLink,
  FileText,
  Lock,
  StickyNote,
  Trash2,
  X
} from 'lucide-react'
import type { Application, ApplicationStatus, AuthState } from '../../../shared/types'
import { shortDate } from '../lib/format'

const STATUSES: ApplicationStatus[] = ['applied', 'viewed', 'interview', 'rejected', 'offer']

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  applied: 'Applied',
  viewed: 'Viewed',
  interview: 'Interview',
  rejected: 'Rejected',
  offer: 'Offer'
}

interface Props {
  auth: AuthState
  onSignIn: () => void
}

export default function Applications({ auth, onSignIn }: Props): JSX.Element {
  const [apps, setApps] = useState<Application[]>([])
  const [notesFor, setNotesFor] = useState<Application | null>(null)
  const [cachedFor, setCachedFor] = useState<Application | null>(null)

  const load = useCallback(async () => {
    if (!auth.loggedIn) return
    setApps(await window.seekr.applications.list())
  }, [auth.loggedIn])

  useEffect(() => {
    void load()
    return window.seekr.onApplicationsChanged(setApps)
  }, [load])

  if (!auth.loggedIn) {
    return (
      <>
        <header className="titlebar" />
        <div className="content">
          <div className="empty">
            <div className="empty-icon">
              <Lock size={20} />
            </div>
            <h3>Application tracking needs your Indeed account</h3>
            <p>
              Once you're signed in, every job you apply to through Seekr is logged here — with its
              status, your notes, and a saved copy of the listing.
            </p>
            <button className="btn primary" onClick={onSignIn}>
              Sign in to Indeed
            </button>
          </div>
        </div>
      </>
    )
  }

  const now = Date.now()

  return (
    <>
      <header className="titlebar">
        <div className="modal-title" style={{ fontSize: 'var(--text-md)' }}>
          My applications
        </div>
        <div className="spacer" />
        <span className="status-pill no-drag">
          {apps.length} tracked
        </span>
      </header>

      <div className="content">
        <div className="reader wide">
          {apps.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <ClipboardList size={20} />
              </div>
              <h3>No applications yet</h3>
              <p>
                Apply to a job from the feed and Seekr will track it here automatically, along with a
                saved copy of the listing in case Indeed takes it down.
              </p>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Applied</th>
                  <th>Status</th>
                  <th>Follow-up</th>
                  <th style={{ width: 1 }} />
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => {
                  const due = app.followUpAt !== null && app.followUpAt <= now
                  return (
                    <tr key={app.jobId}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{app.title}</div>
                        <div style={{ color: 'var(--fg-subtle)', fontSize: 'var(--text-xs)' }}>
                          {app.company}
                        </div>
                      </td>

                      <td style={{ whiteSpace: 'nowrap', color: 'var(--fg-muted)' }}>
                        {shortDate(app.appliedAt)}
                      </td>

                      <td>
                        <select
                          className={`status-select status-${app.status}`}
                          value={app.status}
                          onChange={async (e) =>
                            setApps(
                              await window.seekr.applications.setStatus(
                                app.jobId,
                                e.target.value as ApplicationStatus
                              )
                            )
                          }
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td>
                        <select
                          className="status-select"
                          value={app.followUpAt === null ? '' : 'set'}
                          onChange={async (e) => {
                            const value = e.target.value
                            setApps(
                              await window.seekr.applications.followUp(
                                app.jobId,
                                value === '' ? null : Number(value)
                              )
                            )
                          }}
                          style={due ? { color: 'var(--warn)', fontWeight: 700 } : undefined}
                        >
                          <option value="">
                            {app.followUpAt
                              ? due
                                ? '⏰ Due now'
                                : `${shortDate(app.followUpAt)}`
                              : 'None'}
                          </option>
                          <option value="3">In 3 days</option>
                          <option value="7">In 7 days</option>
                          <option value="14">In 14 days</option>
                        </select>
                      </td>

                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            className="btn sm ghost"
                            data-tip={app.notes ? 'Edit notes' : 'Add notes'}
                            onClick={() => setNotesFor(app)}
                            style={app.notes ? { color: 'var(--accent)' } : undefined}
                          >
                            <StickyNote size={13} />
                          </button>

                          {/* The whole point of the cache: readable after Indeed deletes it. */}
                          <button
                            className="btn sm ghost"
                            data-tip="View the saved copy of this listing"
                            onClick={() => setCachedFor(app)}
                            disabled={!app.cachedListing}
                          >
                            <FileText size={13} />
                          </button>

                          {/* Opens inside Seekr, like everywhere else — the only
                              thing that still leaves for a real browser is nothing. */}
                          <button
                            className="btn sm ghost"
                            data-tip="Open this listing"
                            onClick={() => void window.seekr.job.openUrl(app.url, app.title)}
                          >
                            <ExternalLink size={13} />
                          </button>

                          <button
                            className="btn sm ghost"
                            data-tip="Remove from tracking"
                            onClick={async () =>
                              setApps(await window.seekr.applications.remove(app.jobId))
                            }
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {notesFor && (
        <NotesModal
          application={notesFor}
          onClose={() => setNotesFor(null)}
          onSaved={(next) => {
            setApps(next)
            setNotesFor(null)
          }}
        />
      )}

      {cachedFor && <CachedModal application={cachedFor} onClose={() => setCachedFor(null)} />}
    </>
  )
}

// ------------------------------------------------------------------ notes

function NotesModal({
  application,
  onClose,
  onSaved
}: {
  application: Application
  onClose: () => void
  onSaved: (apps: Application[]) => void
}): JSX.Element {
  const [notes, setNotes] = useState(application.notes)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Notes</div>
          <div style={{ flex: 1 }} />
          <button className="btn icon ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: 'var(--s3)' }}>
            {application.title} · {application.company}
          </div>
          <textarea
            className="textarea"
            value={notes}
            autoFocus
            placeholder="Recruiter name, interview date, what you sent…"
            onChange={(e) => setNotes(e.target.value)}
            style={{ minHeight: 160 }}
          />
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () =>
              onSaved(await window.seekr.applications.update(application.jobId, { notes }))
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------- cached listing

function CachedModal({
  application,
  onClose
}: {
  application: Application
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!application.cachedListing) {
      setMissing(true)
      return
    }
    void window.seekr.applications.cached(application.cachedListing).then((content) => {
      if (content === null) setMissing(true)
      else setText(content)
    })
  }, [application.cachedListing])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-title">{application.title}</div>
            <div className="field-hint">
              Saved by Seekr when you applied — this stays readable even if Indeed removes the
              posting.
            </div>
          </div>
          <button className="btn icon ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {missing ? (
            <div className="banner warn">
              <Bell size={15} />
              <div>The saved copy of this listing is no longer on disk.</div>
            </div>
          ) : text === null ? (
            <div className="field-hint">Loading…</div>
          ) : (
            <pre className="cached-listing">{text}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
