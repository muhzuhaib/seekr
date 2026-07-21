import { useCallback, useEffect, useState } from 'react'
import { Bookmark, Briefcase, ClipboardList, Search, Settings as SettingsIcon } from 'lucide-react'
import type { Application, AuthState, Settings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'
import Feed from './views/Feed'
import Applications from './views/Applications'
import SettingsModal from './views/SettingsModal'
import Onboarding from './views/Onboarding'
import Saved from './views/Saved'
import Tooltip from './views/Tooltip'
import UpdateToast from './views/UpdateToast'

type View = 'feed' | 'saved' | 'applications'

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<View>('feed')
  const [showSettings, setShowSettings] = useState(false)
  const [auth, setAuth] = useState<AuthState>({ loggedIn: false, email: null, checkedAt: 0 })
  const [dueCount, setDueCount] = useState(0)
  const [savedCount, setSavedCount] = useState(0)

  // --- boot
  useEffect(() => {
    void (async () => {
      setSettings(await window.seekr.settings.get())
      setAuth(await window.seekr.auth.state())
      setReady(true)
    })()
  }, [])

  // The main process re-checks the persisted session on launch and tells us here,
  // which is why a login from weeks ago just works with no prompt.
  useEffect(() => window.seekr.onAuthChanged(setAuth), [])

  // Saved jobs are local, so the count is available signed out too.
  useEffect(() => {
    void window.seekr.saved.list().then((list) => setSavedCount(list.length))
    return window.seekr.onSavedChanged((list) => setSavedCount(list.length))
  }, [])

  // --- theme
  useEffect(() => {
    const root = document.documentElement
    const apply = () => {
      const resolved =
        settings.theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : settings.theme
      root.setAttribute('data-theme', resolved)
    }
    apply()

    if (settings.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme])

  // --- font + accent, pushed straight onto the CSS custom properties the
  // stylesheet already reads, so no component needs to know about them.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--font-ui',
      `'${settings.fontFamily}', 'Segoe UI', system-ui, sans-serif`
    )
  }, [settings.fontFamily])

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', settings.accent)
  }, [settings.accent])

  // --- follow-up reminders drive the badge on the applications tab
  const refreshDue = useCallback(async () => {
    if (!auth.loggedIn) {
      setDueCount(0)
      return
    }
    try {
      const apps: Application[] = await window.seekr.applications.list()
      const now = Date.now()
      setDueCount(apps.filter((a) => a.followUpAt !== null && a.followUpAt <= now).length)
    } catch {
      setDueCount(0)
    }
  }, [auth.loggedIn])

  useEffect(() => {
    void refreshDue()
    return window.seekr.onApplicationsChanged(() => void refreshDue())
  }, [refreshDue])

  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await window.seekr.settings.update(patch))
  }, [])

  if (!ready) return <div className="app" />

  // First launch: pick a region before anything else, since every fetch needs one.
  if (!settings.region) {
    return <Onboarding onPick={(region) => void update({ region })} />
  }

  return (
    <div className="app">
      <nav className="rail">
        {/* Matches the app icon: a lens, not a compass. */}
        <div className="rail-logo">
          <Search size={18} strokeWidth={2.6} />
        </div>

        <button
          className={`rail-btn ${view === 'feed' ? 'active' : ''}`}
          onClick={() => setView('feed')}
          data-tip="Jobs"
          data-tip-side="right"
        >
          <Briefcase size={19} />
        </button>

        <button
          className={`rail-btn ${view === 'saved' ? 'active' : ''}`}
          onClick={() => setView('saved')}
          data-tip="Saved jobs"
          data-tip-side="right"
        >
          <Bookmark size={19} />
          {savedCount > 0 && <span className="rail-badge neutral">{savedCount}</span>}
        </button>

        <button
          className={`rail-btn ${view === 'applications' ? 'active' : ''}`}
          onClick={() => setView('applications')}
          data-tip={
            dueCount > 0
              ? `My applications · ${dueCount} follow-up${dueCount === 1 ? '' : 's'} due`
              : 'My applications'
          }
          data-tip-side="right"
        >
          <ClipboardList size={19} />
          {dueCount > 0 && <span className="rail-badge">{dueCount}</span>}
        </button>

        {/* Settings sits at the end of the icon stack, not pinned to the screen bottom. */}
        <div className="rail-divider" />

        <button
          className="rail-btn"
          onClick={() => setShowSettings(true)}
          data-tip="Settings"
          data-tip-side="right"
        >
          <SettingsIcon size={19} />
        </button>
      </nav>

      <div className="main">
        {view === 'feed' && (
          <Feed settings={settings} auth={auth} onOpenSettings={() => setShowSettings(true)} />
        )}
        {view === 'saved' && <Saved settings={settings} auth={auth} />}
        {view === 'applications' && (
          <Applications auth={auth} onSignIn={() => void window.seekr.auth.login()} />
        )}
      </div>

      {showSettings && (
        <SettingsModal
          settings={settings}
          auth={auth}
          onUpdate={update}
          onClose={() => setShowSettings(false)}
        />
      )}

      <UpdateToast />
      <Tooltip />
    </div>
  )
}
