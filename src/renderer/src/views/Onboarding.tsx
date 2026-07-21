import { Search } from 'lucide-react'
import { REGIONS } from '../../../shared/types'

/**
 * First launch. Seekr can't fetch anything until it knows which Indeed country
 * domain to use, so this is the one blocking question we ask.
 */
export default function Onboarding({ onPick }: { onPick: (code: string) => void }): JSX.Element {
  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-logo">
          <Search size={26} strokeWidth={2.6} />
        </div>

        <h1>Welcome to Seekr</h1>
        <p>
          Choose where you're looking for work. Seekr will show jobs from that region — you can
          change this any time in settings.
        </p>

        <div className="region-grid">
          {REGIONS.map((region) => (
            <button key={region.code} className="region-btn" onClick={() => onPick(region.code)}>
              {region.label}
              <small>{region.domain}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
