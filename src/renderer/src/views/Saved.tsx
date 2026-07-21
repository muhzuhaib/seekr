import { useCallback, useEffect, useState } from 'react'
import { Bookmark } from 'lucide-react'
import type { AuthState, SavedJob, Settings } from '../../../shared/types'
import JobCard from './JobCard'
import JobDetail from './JobDetail'

/**
 * Bookmarked jobs. Works signed out — saving is entirely local.
 *
 * The full listing is stored rather than a reference, so a saved job stays readable
 * even after the corpus evicts it or Indeed takes the posting down.
 */
export default function Saved({
  settings,
  auth
}: {
  settings: Settings
  auth: AuthState
}): JSX.Element {
  const [jobs, setJobs] = useState<SavedJob[]>([])
  const [openJob, setOpenJob] = useState<SavedJob | null>(null)

  const load = useCallback(async () => {
    setJobs(await window.seekr.saved.list())
  }, [])

  useEffect(() => {
    void load()
    return window.seekr.onSavedChanged(setJobs)
  }, [load])

  return (
    <>
      <header className="titlebar">
        <div className="modal-title" style={{ fontSize: 'var(--text-md)' }}>
          Saved jobs
        </div>
        <div className="spacer" />
        {jobs.length > 0 && (
          <span className="status-pill no-drag">
            {jobs.length} saved
          </span>
        )}
      </header>

      <div className="content">
        <div className="reader">
          {jobs.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <Bookmark size={22} />
              </div>
              <h3>Nothing saved yet</h3>
              <p>
                Tap the bookmark on any job to keep it here. Seekr stores the whole listing, so a
                saved job stays readable even if Indeed removes the posting.
              </p>
            </div>
          ) : (
            <div className="job-list">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  saved
                  staleAfterDays={settings.staleAfterDays}
                  selected={openJob?.id === job.id}
                  onOpen={(j) => setOpenJob(j as SavedJob)}
                  onToggleSave={async () => {
                    await window.seekr.saved.remove(job.id)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {openJob && (
        <JobDetail
          job={openJob}
          auth={auth}
          staleAfterDays={settings.staleAfterDays}
          onClose={() => setOpenJob(null)}
        />
      )}
    </>
  )
}
