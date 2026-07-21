import { ShieldCheck, X } from 'lucide-react'

/**
 * Seekr's frame around Indeed's verification check.
 *
 * The check itself cannot be native and never will be: Cloudflare binds it to the
 * real browsing context, and Seekr does not solve or bypass bot checks — that is a
 * line the project has held since day one. What it *can* do is stop the check
 * feeling like being thrown out of the app: the challenge window is positioned
 * over Seekr's content area, and this draws the explanation and the way out above
 * it, so it reads as a step in the app rather than a stray browser window.
 *
 * The gap below the caption is where the real check sits. Nothing may be drawn
 * there — that region belongs to a native window layered above this one.
 */
export default function Challenge(): JSX.Element {
  return (
    <div className="challenge-frame">
      <header className="challenge-head">
        <span className="challenge-badge">
          <ShieldCheck size={14} />
          Indeed security check
        </span>
        <p>
          Indeed wants to confirm you’re a person. Complete the check below and Seekr carries on
          from where it stopped — usually only once per session.
        </p>
        <button
          className="btn sm"
          onClick={() => void window.seekr.challenge.cancel()}
          data-tip="Skip the check for now"
        >
          <X size={13} />
          Not now
        </button>
      </header>
    </div>
  )
}
