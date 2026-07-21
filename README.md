# Seekr

A fast, elegant Windows desktop client for Indeed job search.

Seekr puts a modern, minimal interface over your own Indeed session: a clean feed with
Newest / Top / Highest-paid sorting, work-mode sub-filters, exact posting dates, saved jobs,
resume management, and application tracking — all stored locally on your machine.

## Install

Download the latest `Seekr-Setup-x.y.z.exe` from
[Releases](https://github.com/muhzuhaib/seekr/releases) and run it. Seekr updates itself
after that: it checks GitHub in the background and offers a restart when a new version is ready.

## How it works

Indeed has no public job-search API — the Publisher API closed in 2023–24 — so Seekr reads
Indeed pages in an embedded browser window using your own session, at human pace
(one request at a time, spaced out). It never solves CAPTCHAs, never spoofs a browser
fingerprint, and never auto-submits an application: you press the final button yourself.

Everything Seekr stores — settings, cached listings, resumes, applications — lives in your
local app data folder, not in the cloud.

## Development

```bash
npm install
npm run dev        # run in development
npm run typecheck  # type checking
npm run dist       # build the Windows installer into release/
```

Built with Electron, React and TypeScript. No native modules, so no build tools required.
