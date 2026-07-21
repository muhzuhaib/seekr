# Seekr — Plan & fixed architecture decisions

Seekr is a Windows desktop client that gives Indeed job search a polished, minimal, native-feeling
interface. Browsing works logged-out; applying requires the user's real Indeed login.

---

## 1. Data strategy (the decision everything else follows from)

Indeed's Publisher / job-search API was deprecated in 2023–24 and the program is closed to new
developers. What remains is employer-side and partner-only. **There is no API we can call.**

So Seekr drives a real browser session that belongs to the user:

```
┌─────────────────────────────────────────────────────────┐
│ Renderer (React) — the Seekr UI                         │
│   reads ONLY from the local store; never waits on net    │
└───────────────▲─────────────────────────────────────────┘
                │ IPC
┌───────────────┴─────────────────────────────────────────┐
│ Main process                                            │
│  ingest.ts   offscreen BrowserWindow, persist:indeed    │
│  extract.ts  injected DOM reader → raw records          │
│  normalize.ts raw → Job (salary, dates, work mode)      │
│  store.ts    JSON persistence + in-memory index         │
└─────────────────────────────────────────────────────────┘
```

The **same** `persist:indeed` session partition is used by the offscreen ingest window, the login
panel, and the apply panel. That is what makes one login cover everything and survive restarts.

### Rules we hold ourselves to
- Background crawling: one request in flight, ≥ 2.2 s apart with jitter (`throttle.ts`).
- Foreground (v0.4.0): up to 3 at once, ~250 ms apart, across a small pool of reader windows — a
  person reading a results list genuinely does open several listings quickly. Background work
  yields to it entirely, so speculative fetching can never delay a real click.
- Cache aggressively; never re-fetch a page we already have unless the user asks for fresh data.
- On 429 / 403, back off exponentially and surface it in the UI.
- **Never** attempt to solve or bypass a CAPTCHA or bot check. If one appears, show the embedded
  browser panel and let the user complete it themselves.
- No proxy rotation, no fingerprint spoofing, no detection evasion. This is a personal client
  browsing at human pace with the user's own account.

### Known fragility
DOM extraction breaks when Indeed changes markup. Mitigations: every selector lives in one place
(`extract.ts` SELECTORS), extraction reports a health score, and the UI shows a clear banner when
extraction yield drops instead of silently showing an empty feed.

---

## 2. Framework choice: Electron (not Tauri)

Tauri would be lighter, but Seekr needs three things Electron does far better:
1. A persistent, disk-backed session partition (the 30-day login).
2. Injectable content scripts into the page we're reading.
3. A Chromium that Google's sign-in flow will actually accept.

Performance is handled by architecture, not by framework: the UI only ever reads the local store,
so it never blocks on the network.

---

## 3. Storage

Plain JSON files under `app.getPath('userData')/`, loaded into memory on boot, written back
debounced. **No native modules** (no better-sqlite3) so the user never needs build tools.

```
userData/
  settings.json        theme, font, region, thresholds, keywords, blocks
  jobs.json            ingested job corpus (capped, LRU-evicted)
  applications.json    application tracking records
  resumes/             up to 10 resume files + index.json
  cached/<jobId>.txt   full listing snapshot saved at apply time
```

Corpus is capped (default 5000 jobs) and evicted oldest-first, so the file stays a few MB.

---

## 4. Feature decisions

### Work-mode classifier (`normalize.ts`)
"Remote" is scored, not keyword-matched, because listings spam the word. Signals:
- **Positive:** "fully remote", "100% remote", "work from anywhere", "remote-first",
  location field literally "Remote".
- **Negative (clickbait detectors):** a concrete city/postcode in the location field,
  "hybrid", "days in office", "must reside in/near", "on-site", "relocate".
Only listings clearing the positive threshold with no strong negative are shown under Remote.
`hybrid` requires an explicit hybrid signal. Confidence is stored so the UI can explain itself.

### "Top jobs" is an estimate, and says so
Indeed exposes no popularity number. Seekr computes a proxy score from Indeed's own result rank,
promoted/"urgently hiring" flags, applicant hints when present, and recency. The UI labels it as an
estimate rather than implying it is real Indeed data.

### Salary insights come from Seekr's own corpus
No Glassdoor scraping (blocked, and a second fragile scraper). Seekr computes the median salary for
the same normalised job title in the same region across everything it has ingested, and reports the
comparison only once it has a minimum sample (default 5). Below that it says "not enough data yet".

### Applying
Indeed's genuine apply flow renders inside Seekr in an embedded panel. Seekr never auto-submits an
application — the user presses the final button. On submit-detection Seekr writes the application
record and the `.txt` listing snapshot.

---

## 5. Build phases

- **P0** Scaffold, config, docs, shared types.
- **P1** Throttle, ingest, extract, normalize, store.
- **P2** UI shell, design system, dark/light, font picker, settings modal, feed with the three
  filters + sub-filters + date reveal + stale dimming. (Works logged-out.)
- **P3** Login panel (email + Google), persistent session, login-state detection.
- **P4** Keyword filter + toggle, keyword blocking, company blocking, resume manager, salary
  insights overlay.
- **P5** Apply panel, applications dashboard (status, notes, reminders), `.txt` listing cache
  and its reader.

---

## 6. Feature checklist

Everything from the original spec, plus what has been added since. Ticked items are built
**and** verified in a real build.

### Core shell
- [x] Electron + React + TypeScript scaffold, no native modules
- [x] Modern minimal design system, dark + light mode
- [x] Font picker (Windows-bundled fonts only)
- [x] Accent-colour picker
- [x] Settings modal (Appearance / Feed / Keywords / Blocking / Resumes / Account / About)
- [x] First-launch region picker (14 Indeed country domains)
- [x] Frameless titlebar with Windows controls clearance
- [x] Themed tooltips (no native OS boxes)
- [x] Themed confirm dialogs (no native OS message boxes)
- [x] Custom scrollbars
- [x] Opens maximised, always reveals a window (5 reveal triggers + timeout backstop)
- [x] Single-instance lock with stale-lock self-heal, no zombie processes

### Job feed
- [x] Three feed filters: Newest / Top / Highest paid
- [x] "Top" is a labelled estimate (rank + promoted flags + applicant hints + recency)
- [x] Work-mode sub-filters: Remote / Hybrid / On-site
- [x] Scored remote classifier that rejects "remote" clickbait
- [x] Reads Indeed's structured "Work Location:" line as authoritative
- [x] Re-classifies work mode once the full description is fetched
- [x] Empty feed names the filter actually responsible for hiding everything
- [x] Descriptions cached forever + prefetched on hover (instant open)
- [x] Adjustable remote strictness
- [x] Date Reveal — exact posting dates from Indeed's `pubDate`
- [x] Stale dimming past a user-set age
- [x] Job detail view
- [x] Open the original listing on Indeed
- [x] Honest banner when extraction yield drops, instead of a silently empty feed
- [x] Throttled ingestion (one request at a time, ≥2.5 s apart, exponential back-off)
- [x] User-driven verification when Cloudflare challenges, never solved by Seekr

### Signed-in features
- [x] Persistent Indeed login in a shared session partition (email + Google)
- [x] Keyword filter with on/off toggle, saved list drives what gets fetched
- [x] Blocked keywords
- [x] Blocked companies
- [x] Resume manager (up to 10, user-named)
- [x] Salary insight from Seekr's own corpus, with a minimum sample before it speaks
- [x] Embedded apply panel — user presses the final button, never Seekr
- [x] Application tracking dashboard: status, notes, follow-up reminders
- [x] `.txt` snapshot of every applied-to listing, and a reader for it
- [x] Saved jobs / bookmarks (works signed out, stores the whole listing)

### Distribution
- [x] NSIS one-click installer with generated icon (`npm run dist`)
- [x] Auto-update via electron-updater against GitHub Releases
- [x] "Update available — restart to install" toast
- [x] App version + "Check for updates" in Settings → About
- [x] Git repository + .gitignore + README + MIT licence
- [x] GitHub repo created and first release published (github.com/muhzuhaib/seekr, v0.2.0)

### Settled
- [x] Feed layout: Standard / Full width / Two columns — kept as a permanent feature (v0.4.0).
      The toolbar chip stays (it is the fastest way to switch) and the same setting also lives in
      Settings → Appearance. The BETA marker is gone.

### Still to verify / do
- [ ] Verify Google sign-in inside the embedded login window
- [ ] One real end-to-end apply, confirming the `.txt` snapshot and dashboard row
- [x] Check Top / Highest-paid ordering against a large corpus (v0.4.0: verified strictly descending
      across 260+ salaried listings, after fixing three salary-parsing faults that put junk on top)
- [ ] Sanity-check salary medians once the corpus is big enough to be meaningful
- [x] Background backfill of descriptions (v0.4.0): the first 8 cards of every feed are warmed, and
      choosing Remote fetches the description of every possible remote job, because the
      "Job Location:" line that actually decides it only exists on the job page
