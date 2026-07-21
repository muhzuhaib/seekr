import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Building,
  Clock3,
  Columns3,
  Flame,
  Loader2,
  RefreshCw,
  Search,
  SearchX,
  ShieldCheck,
  Wallet,
  Wifi,
  X
} from 'lucide-react'
import type {
  AuthState,
  FeedFilter,
  FeedQuery,
  IngestStatus,
  Job,
  SalaryInsight,
  Settings,
  WorkMode
} from '../../../shared/types'
import { LAYOUTS, LOOKBACK_DAYS, regionByCode } from '../../../shared/types'
import JobCard from './JobCard'
import JobDetail from './JobDetail'

interface Props {
  settings: Settings
  auth: AuthState
  onOpenSettings: () => void
  onUpdateSettings: (patch: Partial<Settings>) => void
}

const FILTERS: { id: FeedFilter; label: string; icon: JSX.Element; hint: string }[] = [
  {
    id: 'recent',
    label: 'Recent',
    icon: <Clock3 size={14} />,
    hint: `Newest postings from the last ${LOOKBACK_DAYS} days. Always fetches fresh.`
  },
  {
    id: 'top',
    label: 'Top',
    icon: <Flame size={14} />,
    hint: `Most in-demand roles from the last ${LOOKBACK_DAYS} days (Seekr estimate).`
  },
  {
    id: 'paid',
    label: 'Highest paid',
    icon: <Wallet size={14} />,
    hint: `Best-paying roles from the last ${LOOKBACK_DAYS} days — highest salary first.`
  }
]

const MODES: { id: WorkMode | 'any'; label: string }[] = [
  { id: 'any', label: 'Any' },
  { id: 'remote', label: 'Remote' },
  { id: 'onsite', label: 'On-site' },
  { id: 'hybrid', label: 'Hybrid' }
]

export default function Feed({
  settings,
  auth,
  onOpenSettings,
  onUpdateSettings
}: Props): JSX.Element {
  const [filter, setFilter] = useState<FeedFilter>('recent')
  const [mode, setMode] = useState<WorkMode | 'any'>('any')
  const [requireSalary, setRequireSalary] = useState(false)
  const [search, setSearch] = useState('')
  const [jobs, setJobs] = useState<Job[]>([])
  const [insights, setInsights] = useState<Record<string, SalaryInsight>>({})
  const [filteredOut, setFilteredOut] = useState(0)
  const [workModeMatches, setWorkModeMatches] = useState(0)
  const [warning, setWarning] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<IngestStatus | null>(null)
  const [openJob, setOpenJob] = useState<Job | null>(null)
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())

  const region = regionByCode(settings.region)
  const keywordsActive = auth.loggedIn && settings.keywordFilterEnabled

  // Committed search term — typing shouldn't refetch on every keystroke.
  const [committedSearch, setCommittedSearch] = useState('')

  const query = useMemo<FeedQuery>(
    () => ({
      filter,
      region: region.code,
      keywords: committedSearch ? [committedSearch] : [],
      workMode: mode,
      requireSalary,
      useSavedKeywords: keywordsActive && !committedSearch
    }),
    [filter, region.code, committedSearch, mode, requireSalary, keywordsActive]
  )

  useEffect(() => window.seekr.onIngestStatus(setStatus), [])

  // Which jobs are bookmarked, so cards render the right state immediately.
  useEffect(() => {
    void window.seekr.saved.ids().then((ids) => setSavedIds(new Set(ids)))
    return window.seekr.onSavedChanged((list) => setSavedIds(new Set(list.map((j) => j.id))))
  }, [])

  const loadInsights = useCallback(async (list: Job[]) => {
    const withSalary = list.filter((j) => j.salary).map((j) => j.id)
    if (withSalary.length === 0) {
      setInsights({})
      return
    }
    setInsights(await window.seekr.salary.insights(withSalary))
  }, [])

  const apply = useCallback(
    async (fresh: boolean) => {
      setLoading(true)
      const result = fresh
        ? await window.seekr.feed.refresh(query)
        : await window.seekr.feed.get(query)
      setJobs(result.jobs)
      setFilteredOut(result.filteredOut)
      setWorkModeMatches(result.workModeMatches)
      setWarning(result.warning)
      setLoading(false)
      void loadInsights(result.jobs)
    },
    [query, loadInsights]
  )

  // The spec is explicit that Recent must pull live data rather than serve cache, so
  // the first visit to each filter fetches; afterwards the local corpus answers
  // instantly and the user refreshes on demand.
  const fetched = useRef<Set<string>>(new Set())

  useEffect(() => {
    const key = `${filter}:${region.code}:${committedSearch}`
    const needsFresh = filter === 'recent' || !fetched.current.has(key)
    fetched.current.add(key)
    void apply(needsFresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, region.code, committedSearch])

  /*
    The remote check re-decides listings in the background — once it finds any, the
    feed re-reads itself so the newly confirmed remote jobs simply appear.
  */
  useEffect(() => window.seekr.onCorpusChanged(() => void apply(false)), [apply])

  // Sub-filter changes are pure local re-filtering — no network, instant.
  useEffect(() => {
    void apply(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, requireSalary, keywordsActive, settings.remoteConfidenceFloor])

  const busy = status?.running ?? false
  const activeFilter = FILTERS.find((f) => f.id === filter)!
  const activeLayout = LAYOUTS.find((l) => l.id === settings.layout) ?? LAYOUTS[0]
  const needsVerification = !!warning && /verification check/i.test(warning)

  /*
    An empty feed should name the filter that emptied it.

    "Remote" + "Salary shown" is the case that caused real confusion: there were
    genuinely remote jobs, but none of them stated pay, so the list went to zero
    and looked like the remote filter was broken. Now it says exactly that.
  */
  const modeLabel = MODES.find((m) => m.id === mode)?.label.toLowerCase() ?? 'this work mode'
  const emptyExplanation =
    requireSalary && workModeMatches > 0
      ? `Seekr found ${workModeMatches} ${mode === 'any' ? '' : `${modeLabel} `}job${workModeMatches === 1 ? '' : 's'}, but ${workModeMatches === 1 ? 'it doesn’t' : 'none of them'} state pay. Turn off “Salary shown” to see ${workModeMatches === 1 ? 'it' : 'them'}.`
      : mode !== 'any' && workModeMatches === 0 && filteredOut > 0
        ? `None of the ${filteredOut} listing${filteredOut === 1 ? '' : 's'} Seekr has for ${region.label} came out as ${modeLabel}. Try “Any”, or fetch more listings.`
        : filteredOut > 0
          ? `Seekr hid ${filteredOut} listing${filteredOut === 1 ? '' : 's'} because of your filters. Try widening the work mode, or turn off “Salary shown”.`
          : `Nothing came back for ${activeFilter.label.toLowerCase()} in ${region.label}. Try refreshing, or search for a job title.`

  return (
    <>
      <header className="titlebar">
        <div className="segmented no-drag">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? 'active' : ''}
              onClick={() => setFilter(f.id)}
              data-tip={f.hint}
            >
              {f.icon}
              {f.label}
            </button>
          ))}
        </div>

        <div className="search no-drag">
          <Search size={14} />
          <input
            className="input"
            placeholder="Search job titles…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              /*
                Emptying the box means "take me back to the home feed" — it should
                not need an Enter press. Without this the last search stayed
                committed, and its results kept showing under all three filters.
              */
              if (e.target.value.trim() === '') setCommittedSearch('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setCommittedSearch(search.trim())
              if (e.key === 'Escape') {
                setSearch('')
                setCommittedSearch('')
              }
            }}
          />
          {search && (
            <button
              className="search-clear"
              onClick={() => {
                setSearch('')
                setCommittedSearch('')
              }}
              data-tip="Clear the search and go back to the home feed"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="spacer" />

        {busy && (
          <span className="status-pill no-drag">
            <Loader2 size={12} className="spin" />
            {status?.message}
          </span>
        )}

        <button
          className="btn icon ghost no-drag"
          onClick={() => void apply(true)}
          disabled={busy}
          data-tip="Fetch the latest listings from Indeed"
        >
          <RefreshCw size={15} className={busy ? 'spin' : ''} />
        </button>
      </header>

      <div className={`toolbar layout-${settings.layout}`}>
        <div className="segmented">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={mode === m.id ? 'active' : ''}
              onClick={() => setMode(m.id)}
              data-tip={
                m.id === 'remote'
                  ? 'Only genuinely remote roles — listings that merely say "remote" but name a city are filtered out'
                  : undefined
              }
            >
              {m.id === 'remote' && <Wifi size={13} />}
              {m.id === 'onsite' && <Building size={13} />}
              {m.label}
            </button>
          ))}
        </div>

        <button
          className={`chip ${requireSalary ? 'on' : ''}`}
          onClick={() => setRequireSalary((v) => !v)}
          data-tip="Hide any listing that doesn't state pay"
        >
          <Wallet size={13} />
          Salary shown
        </button>

        {keywordsActive && (
          <button className="chip on" onClick={onOpenSettings} data-tip="Manage your keywords">
            {settings.savedKeywords.length} keyword
            {settings.savedKeywords.length === 1 ? '' : 's'} active
          </button>
        )}

        <div className="spacer" />

        {/* Feed width. Also lives in Settings → Appearance. */}
        <button
          className="chip"
          onClick={() => {
            const index = LAYOUTS.findIndex((l) => l.id === settings.layout)
            onUpdateSettings({ layout: LAYOUTS[(index + 1) % LAYOUTS.length].id })
          }}
          data-tip={`${activeLayout.hint} — click for the next layout`}
        >
          <Columns3 size={13} />
          {activeLayout.label}
        </button>

        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-subtle)' }}>
          {jobs.length} job{jobs.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="content">
        <div className={`reader layout-${settings.layout}`}>
          {warning && (
            <div className="banner warn">
              <AlertTriangle size={15} />
              <div style={{ flex: 1 }}>
                {warning}
                {/*
                  Cloudflare guards Indeed's search pages and challenges a fresh
                  session. Seekr won't solve that — but once the user clears it in a
                  real window, the clearance cookie lands in the same session the
                  fetcher uses, and ingestion works from then on.
                */}
                {needsVerification && (
                  <div style={{ marginTop: 'var(--s3)' }}>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        await window.seekr.verify(filter)
                        void apply(true)
                      }}
                    >
                      <ShieldCheck size={13} />
                      Open Indeed to verify
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {filter === 'top' && jobs.length > 0 && (
            <div className="banner">
              <Flame size={15} />
              <div>
                Indeed doesn't publish how popular a job is, so this ordering is Seekr's own
                estimate — built from Indeed's ranking, urgency flags and how fresh each posting is.
              </div>
            </div>
          )}

          {loading ? (
            <div className="job-list">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton" />
              ))}
            </div>
          ) : jobs.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <SearchX size={22} />
              </div>
              <h3>No jobs match these filters</h3>
              <p>{emptyExplanation}</p>
              <button className="btn" onClick={() => void apply(true)} disabled={busy}>
                <RefreshCw size={14} />
                Fetch from Indeed
              </button>
            </div>
          ) : (
            <div className="job-list">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  insight={insights[job.id]}
                  staleAfterDays={settings.staleAfterDays}
                  selected={openJob?.id === job.id}
                  onOpen={setOpenJob}
                  saved={savedIds.has(job.id)}
                  onToggleSave={async (j) => {
                    const { saved } = await window.seekr.saved.toggle(j.id)
                    setSavedIds((prev) => {
                      const next = new Set(prev)
                      if (saved) next.add(j.id)
                      else next.delete(j.id)
                      return next
                    })
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
