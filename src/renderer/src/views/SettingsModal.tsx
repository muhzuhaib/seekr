import { useEffect, useState } from 'react'
import {
  Ban,
  Download,
  FileText,
  Info,
  Lock,
  LogOut,
  Palette,
  Plus,
  RefreshCcw,
  SlidersHorizontal,
  Tags,
  Trash2,
  Upload,
  User,
  X
} from 'lucide-react'
import type { AuthState, Resume, Settings, ThemeMode, UpdateStatus } from '../../../shared/types'
import { MAX_RESUMES, REGIONS } from '../../../shared/types'
import { fileSize } from '../lib/format'

interface Props {
  settings: Settings
  auth: AuthState
  onUpdate: (patch: Partial<Settings>) => void
  onClose: () => void
}

type Tab = 'appearance' | 'feed' | 'keywords' | 'blocking' | 'resumes' | 'account' | 'about'

/** Fonts that ship with Windows, so the picker never depends on a network fetch. */
const FONTS = [
  'Inter',
  'Segoe UI Variable',
  'Segoe UI',
  'Calibri',
  'Verdana',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Arial',
  'Cascadia Code',
  'Consolas'
]

const ACCENTS = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a', '#0891b2']

export default function SettingsModal({ settings, auth, onUpdate, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('appearance')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tabs: { id: Tab; label: string; icon: JSX.Element; locked?: boolean }[] = [
    { id: 'appearance', label: 'Appearance', icon: <Palette size={14} /> },
    { id: 'feed', label: 'Feed', icon: <SlidersHorizontal size={14} /> },
    { id: 'keywords', label: 'Keywords', icon: <Tags size={14} />, locked: !auth.loggedIn },
    { id: 'blocking', label: 'Blocking', icon: <Ban size={14} />, locked: !auth.loggedIn },
    { id: 'resumes', label: 'Resumes', icon: <FileText size={14} />, locked: !auth.loggedIn },
    { id: 'account', label: 'Account', icon: <User size={14} /> },
    { id: 'about', label: 'About', icon: <Info size={14} /> }
  ]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Settings</div>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn icon ghost" onClick={onClose} data-tip="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
              data-tip={t.locked ? 'Sign in to your Indeed account to use this' : undefined}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {t.locked ? <Lock size={12} /> : t.icon}
                {t.label}
              </span>
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'appearance' && <Appearance settings={settings} onUpdate={onUpdate} />}
          {tab === 'feed' && <FeedSettings settings={settings} onUpdate={onUpdate} />}
          {tab === 'keywords' &&
            (auth.loggedIn ? (
              <Keywords settings={settings} onUpdate={onUpdate} />
            ) : (
              <SignInPrompt what="Keyword filtering" />
            ))}
          {tab === 'blocking' &&
            (auth.loggedIn ? (
              <Blocking settings={settings} onUpdate={onUpdate} />
            ) : (
              <SignInPrompt what="Blocking" />
            ))}
          {tab === 'resumes' &&
            (auth.loggedIn ? <Resumes /> : <SignInPrompt what="Resume management" />)}
          {tab === 'account' && <Account auth={auth} settings={settings} onUpdate={onUpdate} />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ shared

function Field({
  label,
  hint,
  children,
  stack
}: {
  label: string
  hint?: string
  children: React.ReactNode
  stack?: boolean
}): JSX.Element {
  return (
    <div className={`field ${stack ? 'stack' : ''}`}>
      <div>
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint">{hint}</div>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
    />
  )
}

function SignInPrompt({ what }: { what: string }): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Lock size={20} />
      </div>
      <h3>{what} needs your Indeed account</h3>
      <p>
        Sign in and Seekr will keep you signed in — Indeed's session lasts about 30 days, and Seekr
        stores it locally so you won't be asked again each time you open the app.
      </p>
      <button className="btn primary" onClick={() => void window.seekr.auth.login()}>
        Sign in to Indeed
      </button>
    </div>
  )
}

/** Add/remove list used by keywords, blocked words and blocked companies. */
function ListEditor({
  values,
  placeholder,
  onChange
}: {
  values: string[]
  placeholder: string
  onChange: (next: string[]) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const value = draft.trim()
    if (!value) return
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setDraft('')
      return
    }
    onChange([...values, value])
    setDraft('')
  }

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 'var(--s2)', marginBottom: 'var(--s3)' }}>
        <input
          className="input"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button className="btn" onClick={add} disabled={!draft.trim()}>
          <Plus size={14} />
          Add
        </button>
      </div>

      {values.length === 0 ? (
        <div className="field-hint">Nothing added yet.</div>
      ) : (
        <div className="pills">
          {values.map((value) => (
            <span className="pill" key={value}>
              {value}
              <button onClick={() => onChange(values.filter((v) => v !== value))} data-tip="Remove">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------- appearance

function Appearance({
  settings,
  onUpdate
}: {
  settings: Settings
  onUpdate: (p: Partial<Settings>) => void
}): JSX.Element {
  return (
    <>
      <Field label="Theme" hint="Follow Windows, or pin Seekr to light or dark.">
        <div className="segmented">
          {(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              className={settings.theme === mode ? 'active' : ''}
              onClick={() => onUpdate({ theme: mode })}
            >
              {mode[0].toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Font" hint="Applies across the whole app.">
        <select
          className="select"
          value={settings.fontFamily}
          onChange={(e) => onUpdate({ fontFamily: e.target.value })}
          style={{ fontFamily: `'${settings.fontFamily}', sans-serif` }}
        >
          {FONTS.map((font) => (
            <option key={font} value={font} style={{ fontFamily: `'${font}', sans-serif` }}>
              {font}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Accent colour">
        <div className="swatches">
          {ACCENTS.map((colour) => (
            <button
              key={colour}
              className={`swatch ${settings.accent === colour ? 'active' : ''}`}
              style={{ background: colour }}
              onClick={() => onUpdate({ accent: colour })}
              data-tip={colour}
            />
          ))}
        </div>
      </Field>
    </>
  )
}

// -------------------------------------------------------------------- feed

function FeedSettings({
  settings,
  onUpdate
}: {
  settings: Settings
  onUpdate: (p: Partial<Settings>) => void
}): JSX.Element {
  return (
    <>
      <Field label="Region" hint="Which Indeed site Seekr searches.">
        <select
          className="select"
          value={settings.region ?? 'us'}
          onChange={(e) => onUpdate({ region: e.target.value })}
        >
          {REGIONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Dim listings older than"
        hint="Older postings stay in the feed but are faded, so you can see at a glance which ones are probably stale."
      >
        <input
          className="input"
          type="number"
          min={1}
          max={90}
          value={settings.staleAfterDays}
          onChange={(e) => onUpdate({ staleAfterDays: Math.max(1, Number(e.target.value) || 15) })}
          style={{ width: 78 }}
        />
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-muted)' }}>days</span>
      </Field>

      <Field
        label="Remote strictness"
        hint="How sure Seekr must be before showing a job under the Remote filter. Higher means fewer results but far less clickbait — listings that say 'remote' while naming a city get dropped."
      >
        <input
          type="range"
          min={0.3}
          max={0.9}
          step={0.05}
          value={settings.remoteConfidenceFloor}
          onChange={(e) => onUpdate({ remoteConfidenceFloor: Number(e.target.value) })}
        />
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-muted)', width: 64 }}>
          {settings.remoteConfidenceFloor >= 0.75
            ? 'Strict'
            : settings.remoteConfidenceFloor >= 0.5
              ? 'Balanced'
              : 'Loose'}
        </span>
      </Field>

      <Field
        label="Salary comparison sample"
        hint="Seekr compares a salary against similar roles it has already seen. Below this many comparable listings it says 'not enough data' instead of guessing."
      >
        <input
          className="input"
          type="number"
          min={3}
          max={50}
          value={settings.salaryMinSample}
          onChange={(e) => onUpdate({ salaryMinSample: Math.max(3, Number(e.target.value) || 5) })}
          style={{ width: 78 }}
        />
      </Field>
    </>
  )
}

// ---------------------------------------------------------------- keywords

function Keywords({
  settings,
  onUpdate
}: {
  settings: Settings
  onUpdate: (p: Partial<Settings>) => void
}): JSX.Element {
  return (
    <>
      <Field
        label="Filter the feed by my keywords"
        hint="When on, all three feed filters show only jobs matching your keywords. Turning it off keeps the list saved — your feed just behaves like a normal one."
      >
        <Toggle
          on={settings.keywordFilterEnabled}
          onChange={(v) => onUpdate({ keywordFilterEnabled: v })}
        />
      </Field>

      <div className="section-title">Your keywords</div>
      <div className="field-hint" style={{ marginBottom: 'var(--s3)' }}>
        For example: IT, fashion, business, teacher. Seekr searches Indeed for each one, so these
        shape what gets fetched — not just what gets shown.
      </div>
      <ListEditor
        values={settings.savedKeywords}
        placeholder="Add a keyword and press Enter"
        onChange={(savedKeywords) => onUpdate({ savedKeywords })}
      />
    </>
  )
}

// ---------------------------------------------------------------- blocking

function Blocking({
  settings,
  onUpdate
}: {
  settings: Settings
  onUpdate: (p: Partial<Settings>) => void
}): JSX.Element {
  return (
    <>
      <div className="section-title">Blocked keywords</div>
      <div className="field-hint" style={{ marginBottom: 'var(--s3)' }}>
        Any listing containing one of these anywhere — title, company, or description — is hidden
        completely.
      </div>
      <ListEditor
        values={settings.blockedKeywords}
        placeholder="Add a word to block"
        onChange={(blockedKeywords) => onUpdate({ blockedKeywords })}
      />

      <div className="section-title" style={{ marginTop: 'var(--s6)' }}>
        Blocked companies
      </div>
      <div className="field-hint" style={{ marginBottom: 'var(--s3)' }}>
        Postings from these companies never appear. Partial names work — blocking “Acme” also hides
        “Acme Recruitment”.
      </div>
      <ListEditor
        values={settings.blockedCompanies}
        placeholder="Add a company to block"
        onChange={(blockedCompanies) => onUpdate({ blockedCompanies })}
      />
    </>
  )
}

// ----------------------------------------------------------------- resumes

function Resumes(): JSX.Element {
  const [resumes, setResumes] = useState<Resume[]>([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.seekr.resumes.list().then(setResumes)
  }, [])

  const guard = async (fn: () => Promise<Resume[]>): Promise<void> => {
    setError(null)
    try {
      setResumes(await fn())
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, ''))
    }
  }

  const full = resumes.length >= MAX_RESUMES

  return (
    <>
      <div className="field-hint" style={{ marginBottom: 'var(--s4)' }}>
        Save up to {MAX_RESUMES} resumes with your own titles. Titles are only ever shown to you —
        employers see the file itself.
      </div>

      {error && (
        <div className="banner bad" style={{ marginBottom: 'var(--s4)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--s2)', marginBottom: 'var(--s5)' }}>
        <input
          className="input"
          placeholder="Title for this resume, e.g. “Design roles”"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={full}
        />
        <button
          className="btn primary"
          disabled={full}
          onClick={() =>
            void guard(async () => {
              const next = await window.seekr.resumes.add(title)
              setTitle('')
              return next
            })
          }
        >
          <Upload size={14} />
          Choose file
        </button>
      </div>

      {resumes.length === 0 ? (
        <div className="field-hint">No resumes saved yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Size</th>
              <th style={{ width: 1 }} />
            </tr>
          </thead>
          <tbody>
            {resumes.map((resume) => (
              <tr key={resume.id}>
                <td>
                  <input
                    className="input"
                    value={resume.title}
                    onChange={(e) =>
                      setResumes((list) =>
                        list.map((r) => (r.id === resume.id ? { ...r, title: e.target.value } : r))
                      )
                    }
                    onBlur={(e) =>
                      void guard(() => window.seekr.resumes.rename(resume.id, e.target.value))
                    }
                  />
                </td>
                <td style={{ color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>
                  {fileSize(resume.sizeBytes)}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="btn sm ghost"
                      data-tip="Replace the file"
                      onClick={() => void guard(() => window.seekr.resumes.replace(resume.id))}
                    >
                      <RefreshCcw size={13} />
                    </button>
                    <button
                      className="btn sm ghost"
                      data-tip="Delete"
                      onClick={() => void guard(() => window.seekr.resumes.remove(resume.id))}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// ------------------------------------------------------------------- about

/** One line of plain English per update phase, so the button always says something. */
function updateLine(status: UpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${status.newVersion} found.`
    case 'downloading':
      return `Downloading version ${status.newVersion ?? ''}… ${status.progress}%`
    case 'ready':
      return `Version ${status.newVersion} is downloaded. Restart Seekr to finish installing.`
    case 'none':
      return "You're on the latest version."
    case 'error':
      return status.message || 'Could not check for updates right now.'
    case 'unsupported':
      return status.message || 'Updates apply to the installed app only.'
    default:
      return 'Seekr checks for updates automatically in the background.'
  }
}

function About(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void window.seekr.update.status().then(setStatus)
    return window.seekr.onUpdateStatus(setStatus)
  }, [])

  const busy = status?.phase === 'checking' || status?.phase === 'downloading'

  return (
    <>
      <Field label="App version" hint="The version of Seekr you're running right now.">
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)' }}>
          {status?.currentVersion ?? '—'}
        </span>
      </Field>

      <Field
        label="Updates"
        hint="Seekr checks GitHub for new versions in the background and downloads them quietly. Nothing installs until you restart."
        stack
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s3)', flexWrap: 'wrap' }}>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void window.seekr.update.check().then(setStatus)}
          >
            <RefreshCcw size={14} />
            Check for updates
          </button>

          {status?.phase === 'ready' && (
            <button className="btn primary" onClick={() => void window.seekr.update.install()}>
              <Download size={14} />
              Restart &amp; install
            </button>
          )}

          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-subtle)' }}>
            {status ? updateLine(status) : ''}
          </span>
        </div>
      </Field>
    </>
  )
}

// ----------------------------------------------------------------- account

function Account({
  auth,
  settings,
  onUpdate
}: {
  auth: AuthState
  settings: Settings
  onUpdate: (p: Partial<Settings>) => void
}): JSX.Element {
  return (
    <>
      <Field
        label="Indeed account"
        hint={
          auth.loggedIn
            ? 'Signed in. Seekr stores the session locally and reuses it, so you stay signed in for as long as Indeed allows — around 30 days.'
            : 'Browsing works without an account. Signing in unlocks applying, keywords, blocking, resumes and application tracking.'
        }
      >
        {auth.loggedIn ? (
          <button className="btn danger" onClick={() => void window.seekr.auth.logout()}>
            <LogOut size={14} />
            Sign out
          </button>
        ) : (
          <button className="btn primary" onClick={() => void window.seekr.auth.login()}>
            Sign in
          </button>
        )}
      </Field>

      {auth.email && <Field label="Signed in as">{auth.email}</Field>}

      <div className="section-title" style={{ marginTop: 'var(--s6)' }}>
        Local data
      </div>

      <Field
        label="Clear cached jobs"
        hint="Removes every job Seekr has stored locally. Your settings, resumes and applications are kept. Salary comparisons will need to rebuild their sample afterwards."
      >
        <button
          className="btn danger"
          onClick={() => {
            void window.seekr.clearCorpus()
          }}
        >
          <Trash2 size={14} />
          Clear
        </button>
      </Field>

      <Field
        label="Reset all settings"
        hint="Puts every option back to its default. Your region is kept so the feed keeps working."
      >
        <button
          className="btn danger"
          onClick={async () => {
            await window.seekr.settings.reset()
            // Re-apply the region so resetting doesn't drop the user back to onboarding.
            onUpdate({ region: settings.region })
          }}
        >
          Reset
        </button>
      </Field>
    </>
  )
}
