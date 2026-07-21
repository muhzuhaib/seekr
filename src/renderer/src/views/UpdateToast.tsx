import { useEffect, useState } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'
import type { UpdateStatus } from '../../../shared/types'

/**
 * The whole visible surface of auto-update: one small card, bottom-right, only
 * once a new version is downloaded and genuinely ready. Checking and downloading
 * stay silent — a job search shouldn't be interrupted by housekeeping.
 *
 * Dismissing hides it for this run only; it comes back next launch, and Settings
 * always shows the same state.
 */
export default function UpdateToast(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void window.seekr.update.status().then(setStatus)
    return window.seekr.onUpdateStatus(setStatus)
  }, [])

  if (!status || status.phase !== 'ready' || dismissed) return null

  return (
    <div className="update-toast">
      <ArrowUpCircle size={17} />
      <div className="update-toast-text">
        Update available{status.newVersion ? ` — version ${status.newVersion}` : ''}
        <small>Restart to install</small>
      </div>
      <button className="btn sm primary" onClick={() => void window.seekr.update.install()}>
        Restart
      </button>
      <button
        className="btn sm icon ghost"
        onClick={() => setDismissed(true)}
        data-tip="Not now"
        data-tip-side="top"
      >
        <X size={13} />
      </button>
    </div>
  )
}
