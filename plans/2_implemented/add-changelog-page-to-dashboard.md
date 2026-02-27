# Dashboard Changelog Page

## Context

The dashboard home page has a "Git Log" box showing 5 recent commits. The user wants to:

1. Rename it to "OpenClaw Change Log `<version>`" with the actual version
2. Add a "View Details ->" link
3. Both the title and link navigate to a new `/changelog` page showing the full CHANGELOG.md and 50 git log entries

**Data availability**: All data is already in the container:

- CHANGELOG.md at `/app/CHANGELOG.md` (in `package.json` `files` array)
- Version via `getVersion()` in `data/stats.mjs` (reads `/app/package.json`)
- Git log via `getGit()` from `/app/.git-info` (currently 10 entries, need 50)

## Changes

### 1. Increase git log snapshot from 10 to 50 entries

**File**: `deploy/build-openclaw.sh` (line 68)

- Change `git log --format='%h%x09%s%x09%aI' -10` to `-50`

### 2. Update Git Log box on home page

**File**: `deploy/dashboard/html/home.html` (lines 175-177, 648)

- Change title from `📜 Git Log` to `📜 OpenClaw Change Log <version>`
- Make the title a clickable link to `/changelog`
- Add "View Details ->" link below git entries
- Version comes from `D.version` (already in stats API response)

### 3. Create changelog page handler

**New file**: `deploy/dashboard/pages/changelog.mjs`

- Follow same pattern as `pages/stats.mjs`
- Read CHANGELOG.md (with caching) and version at serve time
- Embed as `window.__CHANGELOG_DATA = { version, changelog }` in the HTML
- Git log data fetched client-side from existing stats API

### 4. Create changelog page HTML template

**New file**: `deploy/dashboard/html/changelog.html`

- Title: "OpenClaw Change Log `<version>`"
- Top box: render CHANGELOG.md with scrollable container (max-height ~500px), use minimal inline markdown-to-HTML renderer (handles `#` headings, `**bold**`, `- lists`, `` `code` ``, `---` hr)
- Bottom box: show 50 git log entries (same format as home page, no scroll limit)
- Fetches git log from `__STATS_BASE + '/api/refresh'`
- Auto-refresh like other pages (60s timer with countdown)

### 5. Add route to server

**File**: `deploy/dashboard/server.mjs`

- Import changelog handler
- Add route for `/changelog`

### 6. Add changelog to nav header

**File**: `deploy/dashboard/layout.mjs`

- Add "Changelog" link between "Logs" and the `|` separator

## Verification

After deploying to the VPS:

1. Home page: Git Log box title shows "OpenClaw Change Log 2026.x.x"
2. Clicking the title navigates to `/changelog`
3. "View Details ->" link also navigates to `/changelog`
4. Changelog page shows CHANGELOG.md rendered as HTML in a scrollable box
5. Below it, 50 git log entries displayed
6. Nav bar includes "Changelog" link
7. Auto-refresh timer works on the changelog page
