# Cronie Migration + Auto-Update Time Config

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Vixie cron with cronie for proper `CRON_TZ` support (DST-aware scheduling), and add configurable `host.update_time.openclaw` to stack.yml.

**Architecture:** Vixie cron (Ubuntu default) ignores `CRON_TZ` — it only uses the system timezone (UTC) for scheduling. cronie is a drop-in replacement that natively supports `CRON_TZ` in `/etc/cron.d/` files. All existing cron files already use `CRON_TZ` and will work correctly once cronie is installed. The static cron files (backup, session-prune) and auto-update cron need `CRON_TZ` added so they also respect the user's timezone. Auto-update time becomes configurable via `stack.yml`.

**Tech Stack:** Shell scripts, Node.js (pre-deploy.mjs), YAML config, Markdown playbooks

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `build/tz-abbreviations.mjs` | Create | Comprehensive TZ abbreviation → IANA map (extracted from pre-deploy.mjs) |
| `build/parse-schedule-time.mjs` | Create | Extracted `parseScheduleTime` function (testable, imported by pre-deploy.mjs) |
| `build/pre-deploy.mjs` | Modify ~L398-440, ~L525-530 | Import from new modules, add `host.update_time.openclaw` parsing, resolve `{{CRON_TZ}}` in static cron templates |
| `vitest.config.mjs` | Create | Vitest configuration |
| `test/build/tz-abbreviations.test.mjs` | Create | Tests for TZ abbreviation map completeness and validity |
| `test/build/schedule-time.test.mjs` | Create | Tests for time parsing, TZ resolution, edge cases |
| `playbooks/02-base-setup.md` | Modify ~L60 | Add `cronie` to apt install, add note |
| `.claude/skills/setup-vps/SKILL.md` | Modify ~L58-62 | Add `cronie` to apt install in Section 1 |
| `deploy/host/register-cron-jobs.sh` | Modify ~L87-95, ~L117-124 | Add `CRON_TZ` to maintenance and auto-update cron files, make auto-update time configurable, handle empty TZ gracefully |
| `deploy/host/cron-openclaw-backup` | Modify | Add `{{CRON_TZ}}` header |
| `deploy/host/cron-openclaw-session-prune` | Modify | Add `{{CRON_TZ}}` header |
| `stack.yml.example` | Modify ~L14-20 | Add `update_time.openclaw` to host section |
| `playbooks/04-vps1-openclaw.md` | Modify cron deployment section | Note about cronie requirement |
| `playbooks/07-verification.md` | Modify cron verification | Add cronie check |
| `playbooks/08c-deploy-report.md` | Modify ~L119-127 | Fix stale `HOSTALERT_DAILY_REPORT_TIME` references |
| `CHANGELOG.md` | Prepend entry | Migration steps (install cronie, update stack.yml) |

---

### Task 1: Update base setup and setup-vps skill to install cronie

**Files:**

- Modify: `playbooks/02-base-setup.md:60-64`
- Modify: `.claude/skills/setup-vps/SKILL.md:58-62`

- [ ] **Step 1: Add cronie to apt install in playbook 02**

The apt install block at line 60-64 doesn't explicitly install `cron` (it's pre-installed on Ubuntu). Add `cronie`:

```bash
# Install essential packages
sudo apt install -y \
    curl wget git vim htop tmux unzip jq cronie \
    ca-certificates gnupg lsb-release \
    apt-transport-https software-properties-common \
    ufw fail2ban auditd
```

- [ ] **Step 2: Add a note after the apt install block explaining the cronie choice**

After the apt install code block (after line 65), add:

```markdown
> **Why cronie?** Ubuntu ships Vixie cron which ignores `CRON_TZ` in `/etc/cron.d/` files — all jobs run in system time (UTC).
> cronie is a drop-in replacement that supports `CRON_TZ` for timezone-aware scheduling with automatic DST handling.
> Installing cronie automatically replaces Vixie cron and preserves all existing `/etc/cron.d/` files.
```

- [ ] **Step 3: Add cronie to setup-vps skill**

In `.claude/skills/setup-vps/SKILL.md`, Section 1 (line 58-62), add `cronie` to the apt install:

```bash
sudo apt install -y \
    curl wget git vim htop tmux unzip jq cronie \
    ca-certificates gnupg lsb-release \
    apt-transport-https software-properties-common \
    ufw fail2ban
```

Also add a note after the code block (after line 63):

```markdown
**Why cronie?** Ubuntu ships Vixie cron which ignores `CRON_TZ` in `/etc/cron.d/` files. cronie is a drop-in replacement with native `CRON_TZ` support for timezone-aware scheduling with DST handling.
```

- [ ] **Step 4: Commit**

```bash
git add playbooks/02-base-setup.md .claude/skills/setup-vps/SKILL.md
git commit -m "Add cronie to base setup and setup-vps skill for CRON_TZ support"
```

---

### Task 2: Create TZ abbreviations file, update time parsing, add host.update_time.openclaw

**Files:**

- Create: `build/tz-abbreviations.mjs`
- Modify: `build/pre-deploy.mjs:~398-440, ~525-530`
- Modify: `stack.yml.example:14-20`
- Modify: `stack.yml` (gitignored)

- [ ] **Step 1: Create build/tz-abbreviations.mjs**

Extract the TZ abbreviation map from pre-deploy.mjs into a separate file with comprehensive coverage. Export a single `TZ_ABBREVIATIONS` object mapping uppercase abbreviations to IANA timezone names.

Coverage should include (at minimum):

- **US:** PST/PDT, MST/MDT, CST/CDT, EST/EDT, AKST/AKDT, HST, AST
- **Europe:** GMT, BST, CET/CEST, EET/EEST, WET/WEST, MSK, IST (Ireland)
- **Asia:** IST (India), CST (China), JST, KST, HKT, SGT, ICT, WIB/WITA/WIT, PHT, PKT, BDT, NPT, MMT, THA, GST (Gulf)
- **Oceania:** AEST/AEDT, ACST/ACDT, AWST, NZST/NZDT
- **Americas:** BRT/BRST, ART, CLT/CLST, COT, PET, VET, ECT
- **Africa:** WAT, CAT, EAT, SAST

Where abbreviations are ambiguous (e.g., IST = India or Ireland, CST = US Central or China), prefer the more commonly expected mapping and add a comment noting the ambiguity.

```javascript
// build/tz-abbreviations.mjs
// Comprehensive timezone abbreviation → IANA mapping.
// Used by pre-deploy.mjs to convert human-readable times to cron schedules.
// Users can also specify full IANA names directly (e.g. "Asia/Tokyo").

export const TZ_ABBREVIATIONS = {
  // --- Americas ---
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  CST: 'America/Chicago',       // Ambiguous: also China Standard Time — US takes priority
  CDT: 'America/Chicago',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  AKST: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  AST: 'America/Puerto_Rico',   // Atlantic Standard Time
  // ... (continue with full list)
}
```

- [ ] **Step 2: Update parseDailyReportTime in pre-deploy.mjs**

Import the TZ map. Update the function to:

1. Accept abbreviations (looked up in `TZ_ABBREVIATIONS`)
2. Accept full IANA names directly (e.g. `America/Los_Angeles`, `Asia/Tokyo`)
3. If the TZ part contains a `/`, treat it as a full IANA name — use as-is
4. If the TZ part is an abbreviation not in the map, warn and return `ianaTz: ''` (empty string = no CRON_TZ, falls back to VPS host time)
5. Change the fallback from hardcoded `America/Los_Angeles` to empty string

```javascript
import { TZ_ABBREVIATIONS } from './tz-abbreviations.mjs'

function parseScheduleTime(timeStr, label) {
  if (!timeStr) return { cronExpr: '', ianaTz: '' }

  const match = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s+(.+)$/i)
  if (!match) {
    warn(`Could not parse ${label} time "${timeStr}"`)
    return { cronExpr: '', ianaTz: '' }
  }

  let hour = parseInt(match[1], 10)
  const minute = parseInt(match[2], 10)
  const ampm = match[3].toUpperCase()
  const tzPart = match[4].trim()

  if (ampm === 'PM' && hour !== 12) hour += 12
  if (ampm === 'AM' && hour === 12) hour = 0

  // Full IANA name (contains /) — use directly
  let ianaTz
  if (tzPart.includes('/')) {
    ianaTz = tzPart
  } else {
    ianaTz = TZ_ABBREVIATIONS[tzPart.toUpperCase()] || ''
    if (!ianaTz) {
      warn(`Unknown timezone "${tzPart}" in ${label} — schedule will use VPS host timezone`)
    }
  }

  return { cronExpr: `${minute} ${hour} * * *`, ianaTz }
}
```

Rename `parseDailyReportTime` to `parseScheduleTime` (add a `label` param for better warning messages). Update all call sites.

- [ ] **Step 3: Add host.update_time.openclaw to stack.yml.example**

```yaml
host:
  hostname: ${HOSTNAME}

  host_alerter:
    telegram_bot_token: ${HOSTALERT_TELEGRAM_BOT_TOKEN}
    telegram_chat_id: ${HOSTALERT_TELEGRAM_CHAT_ID}
    daily_report: "9:30 AM PST"          # time + TZ abbreviation or IANA name
  auto_update:
    openclaw: "3:00 AM PST"      # when to check for openclaw updates (requires auto_update: true)
```

- [ ] **Step 4: Update the user's stack.yml**

Same change as step 3.

- [ ] **Step 5: Add host.update_time.openclaw parsing to stack.env generation in pre-deploy.mjs**

```javascript
const autoUpdateParsed = parseScheduleTime(host.update_time.openclaw || '3:00 AM PST', 'host.update_time.openclaw')
lines.push(`STACK__HOST__HOSTALERT__AUTO_UPDATE_CRON_EXPR=${autoUpdateParsed.cronExpr}`)
lines.push(`STACK__HOST__HOSTALERT__AUTO_UPDATE_CRON_TZ=${autoUpdateParsed.ianaTz}`)
```

Also emit the resolved CRON_TZ for use by static cron template resolution:

```javascript
lines.push(`STACK__HOST__CRON_TZ=${schedule.ianaTz}`)
```

- [ ] **Step 6: Commit**

```bash
git add build/tz-abbreviations.mjs build/pre-deploy.mjs stack.yml.example
git commit -m "Add comprehensive TZ abbreviations, support IANA names, add host.update_time.openclaw config"
```

---

### Task 3: Add CRON_TZ to all cron files (handle empty TZ gracefully)

**Files:**

- Modify: `deploy/host/register-cron-jobs.sh:~L27-28, ~L67, ~L91, ~L117-124`
- Modify: `deploy/host/cron-openclaw-backup`
- Modify: `deploy/host/cron-openclaw-session-prune`
- Modify: `build/pre-deploy.mjs` (template resolution for static cron files)

All cron file generation must handle empty `CRON_TZ` gracefully — if the timezone couldn't be resolved, omit the `CRON_TZ` line entirely so cronie uses the VPS host timezone.

- [ ] **Step 1: Update register-cron-jobs.sh to conditionally emit CRON_TZ**

Create a helper function at the top of register-cron-jobs.sh:

```bash
# Emit CRON_TZ line only if timezone is set (empty = use VPS host timezone)
emit_cron_tz() {
  [ -n "$1" ] && echo "CRON_TZ=$1"
}
```

Update all `echo "CRON_TZ=..."` lines to use `emit_cron_tz "$CRON_TZ"` instead.

Update the auto-update section (lines 117-124) to use configurable time and TZ:

```bash
AUTO_UPDATE_CRON_EXPR="${STACK__HOST__HOSTALERT__AUTO_UPDATE_CRON_EXPR:-0 3 * * *}"
AUTO_UPDATE_CRON_TZ="${STACK__HOST__HOSTALERT__AUTO_UPDATE_CRON_TZ:-${CRON_TZ}}"

if [ "${STACK__STACK__OPENCLAW__AUTO_UPDATE:-false}" = "true" ]; then
  {
    echo "# Generated by register-cron-jobs.sh — DO NOT EDIT"
    echo "# Daily openclaw version check and rebuild"
    echo ""
    emit_cron_tz "$AUTO_UPDATE_CRON_TZ"
    echo "${AUTO_UPDATE_CRON_EXPR} openclaw ${INSTALL_DIR}/host/auto-update-openclaw.sh >> ${INSTALL_DIR}/logs/auto-update.log 2>&1"
  } > /etc/cron.d/openclaw-auto-update
  chmod 644 /etc/cron.d/openclaw-auto-update
  echo "  Installed /etc/cron.d/openclaw-auto-update (${AUTO_UPDATE_CRON_EXPR} ${AUTO_UPDATE_CRON_TZ:-system tz})"
```

- [ ] **Step 2: Add {{CRON_TZ}} to static cron templates**

Use a conditional `{{CRON_TZ_LINE}}` placeholder that resolves to either `CRON_TZ=<value>` or empty string.

`deploy/host/cron-openclaw-backup`:

```
# OpenClaw daily backup — runs as root to access uid 1000 owned directories
{{CRON_TZ_LINE}}
0 3 * * * root {{INSTALL_DIR}}/host/backup.sh >> {{INSTALL_DIR}}/logs/backup.log 2>&1
```

`deploy/host/cron-openclaw-session-prune`:

```
# OpenClaw session & log pruning — runs as root (uid 1000 owned directories)
{{CRON_TZ_LINE}}
30 3 * * * root {{INSTALL_DIR}}/host/session-prune.sh >> {{INSTALL_DIR}}/logs/session-prune.log 2>&1
```

- [ ] **Step 3: Resolve {{CRON_TZ_LINE}} in pre-deploy.mjs**

Find where `{{INSTALL_DIR}}` is resolved in the static cron templates. Add resolution for `{{CRON_TZ_LINE}}`:

```javascript
const cronTzLine = cronTz ? `CRON_TZ=${cronTz}` : ''
// ...
.replace(/\{\{CRON_TZ_LINE\}\}\n?/g, cronTzLine ? cronTzLine + '\n' : '')
```

This ensures no blank `CRON_TZ=` line or stray newline when TZ is empty.

- [ ] **Step 4: Commit**

```bash
git add deploy/host/register-cron-jobs.sh deploy/host/cron-openclaw-backup deploy/host/cron-openclaw-session-prune build/pre-deploy.mjs
git commit -m "Add CRON_TZ to all cron files, handle empty TZ gracefully"
```

---

### Task 4: Set up vitest and write cron timezone tests

**Files:**

- Modify: `package.json` (add vitest devDependency + test script)
- Create: `vitest.config.mjs`
- Create: `test/build/schedule-time.test.mjs`
- Create: `test/build/tz-abbreviations.test.mjs`

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Add test script to package.json**

```json
"scripts": {
  "pre-deploy": "node build/pre-deploy.mjs",
  "pre-deploy:dry": "node build/pre-deploy.mjs --dry-run",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Create vitest.config.mjs**

```javascript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
  },
})
```

- [ ] **Step 4: Export parseScheduleTime from pre-deploy.mjs for testing**

The `parseScheduleTime` function (renamed from `parseDailyReportTime` in Task 2) needs to be importable. Since pre-deploy.mjs runs as a script with side effects, extract `parseScheduleTime` into a small module:

Create `build/parse-schedule-time.mjs`:

```javascript
import { TZ_ABBREVIATIONS } from './tz-abbreviations.mjs'

export function parseScheduleTime(timeStr, label = 'schedule') {
  // ... (the function body from Task 2 step 2)
}
```

Then import and use it in `build/pre-deploy.mjs`:

```javascript
import { parseScheduleTime } from './parse-schedule-time.mjs'
```

This keeps pre-deploy.mjs clean and makes the function testable.

- [ ] **Step 5: Write test/build/tz-abbreviations.test.mjs**

```javascript
import { describe, it, expect } from 'vitest'
import { TZ_ABBREVIATIONS } from '../../build/tz-abbreviations.mjs'

describe('TZ_ABBREVIATIONS', () => {
  it('maps US abbreviations to IANA names', () => {
    expect(TZ_ABBREVIATIONS.PST).toBe('America/Los_Angeles')
    expect(TZ_ABBREVIATIONS.PDT).toBe('America/Los_Angeles')
    expect(TZ_ABBREVIATIONS.EST).toBe('America/New_York')
    expect(TZ_ABBREVIATIONS.CST).toBe('America/Chicago')
    expect(TZ_ABBREVIATIONS.MST).toBe('America/Denver')
    expect(TZ_ABBREVIATIONS.HST).toBe('Pacific/Honolulu')
  })

  it('maps European abbreviations', () => {
    expect(TZ_ABBREVIATIONS.GMT).toBe('Europe/London')
    expect(TZ_ABBREVIATIONS.CET).toBe('Europe/Berlin')
    expect(TZ_ABBREVIATIONS.EET).toBe('Europe/Bucharest')
    expect(TZ_ABBREVIATIONS.MSK).toBe('Europe/Moscow')
  })

  it('maps Asian abbreviations', () => {
    expect(TZ_ABBREVIATIONS.JST).toBe('Asia/Tokyo')
    expect(TZ_ABBREVIATIONS.KST).toBe('Asia/Seoul')
    expect(TZ_ABBREVIATIONS.IST).toBe('Asia/Kolkata')
    expect(TZ_ABBREVIATIONS.SGT).toBe('Asia/Singapore')
    expect(TZ_ABBREVIATIONS.HKT).toBe('Asia/Hong_Kong')
    expect(TZ_ABBREVIATIONS.PHT).toBe('Asia/Manila')
  })

  it('maps Oceania abbreviations', () => {
    expect(TZ_ABBREVIATIONS.AEST).toBe('Australia/Sydney')
    expect(TZ_ABBREVIATIONS.NZST).toBe('Pacific/Auckland')
  })

  it('maps UTC/GMT', () => {
    expect(TZ_ABBREVIATIONS.UTC).toBe('UTC')
    expect(TZ_ABBREVIATIONS.GMT).toBe('Europe/London')
  })

  it('all values are valid IANA timezone strings', () => {
    for (const [abbr, iana] of Object.entries(TZ_ABBREVIATIONS)) {
      expect(iana, `${abbr} should map to a string with / or be UTC`).toMatch(/\/|^UTC$/)
    }
  })

  it('all keys are uppercase', () => {
    for (const key of Object.keys(TZ_ABBREVIATIONS)) {
      expect(key).toBe(key.toUpperCase())
    }
  })
})
```

- [ ] **Step 6: Write test/build/schedule-time.test.mjs**

```javascript
import { describe, it, expect } from 'vitest'
import { parseScheduleTime } from '../../build/parse-schedule-time.mjs'

describe('parseScheduleTime', () => {
  describe('basic time parsing', () => {
    it('parses AM time with abbreviation', () => {
      const result = parseScheduleTime('9:30 AM PST', 'test')
      expect(result.cronExpr).toBe('30 9 * * *')
      expect(result.ianaTz).toBe('America/Los_Angeles')
    })

    it('parses PM time', () => {
      const result = parseScheduleTime('3:00 PM EST', 'test')
      expect(result.cronExpr).toBe('0 15 * * *')
      expect(result.ianaTz).toBe('America/New_York')
    })

    it('handles 12 PM (noon)', () => {
      const result = parseScheduleTime('12:00 PM UTC', 'test')
      expect(result.cronExpr).toBe('0 12 * * *')
    })

    it('handles 12 AM (midnight)', () => {
      const result = parseScheduleTime('12:00 AM UTC', 'test')
      expect(result.cronExpr).toBe('0 0 * * *')
    })

    it('handles single-digit hour', () => {
      const result = parseScheduleTime('3:00 AM PST', 'test')
      expect(result.cronExpr).toBe('0 3 * * *')
    })
  })

  describe('timezone handling', () => {
    it('resolves abbreviation to IANA', () => {
      const result = parseScheduleTime('9:00 AM JST', 'test')
      expect(result.ianaTz).toBe('Asia/Tokyo')
    })

    it('accepts full IANA name directly', () => {
      const result = parseScheduleTime('9:00 AM Asia/Tokyo', 'test')
      expect(result.ianaTz).toBe('Asia/Tokyo')
    })

    it('accepts IANA name with multiple segments', () => {
      const result = parseScheduleTime('9:00 AM America/Indiana/Indianapolis', 'test')
      expect(result.ianaTz).toBe('America/Indiana/Indianapolis')
    })

    it('returns empty ianaTz for unknown abbreviation', () => {
      const result = parseScheduleTime('9:00 AM FAKE', 'test')
      expect(result.ianaTz).toBe('')
    })

    it('is case-insensitive for abbreviations', () => {
      const result = parseScheduleTime('9:00 AM pst', 'test')
      expect(result.ianaTz).toBe('America/Los_Angeles')
    })

    it('preserves case for IANA names', () => {
      const result = parseScheduleTime('9:00 AM America/Los_Angeles', 'test')
      expect(result.ianaTz).toBe('America/Los_Angeles')
    })
  })

  describe('edge cases', () => {
    it('returns empty for null input', () => {
      const result = parseScheduleTime(null, 'test')
      expect(result.cronExpr).toBe('')
      expect(result.ianaTz).toBe('')
    })

    it('returns empty for empty string', () => {
      const result = parseScheduleTime('', 'test')
      expect(result.cronExpr).toBe('')
      expect(result.ianaTz).toBe('')
    })

    it('returns empty for unparseable input', () => {
      const result = parseScheduleTime('not a time', 'test')
      expect(result.cronExpr).toBe('')
      expect(result.ianaTz).toBe('')
    })

    it('handles DST abbreviation variants', () => {
      const pst = parseScheduleTime('9:00 AM PST', 'test')
      const pdt = parseScheduleTime('9:00 AM PDT', 'test')
      expect(pst.ianaTz).toBe(pdt.ianaTz)
    })
  })
})
```

- [ ] **Step 7: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add package.json vitest.config.mjs test/ build/parse-schedule-time.mjs
git commit -m "Set up vitest, add cron schedule time and TZ abbreviation tests"
```

---

### Task 5: Update playbooks and verification

**Files:**

- Modify: `playbooks/04-vps1-openclaw.md` (cron deployment section)
- Modify: `playbooks/07-verification.md` (cron verification)

- [ ] **Step 1: Add cronie prerequisite note to playbook 04**

In the cron deployment section (4.5), add a note:

```markdown
> **Prerequisite:** cronie must be installed (see playbook 02). Vixie cron (Ubuntu default)
> does not support `CRON_TZ` — all timezone-aware scheduling requires cronie.
```

- [ ] **Step 2: Add cronie verification to playbook 07**

In the cron/alerter verification section, add a check:

```bash
# Verify cronie is installed (not Vixie cron)
dpkg -l cronie | grep -q '^ii' && echo "OK: cronie installed" || echo "FAIL: cronie not installed (CRON_TZ won't work)"
```

- [ ] **Step 3: Fix stale HOSTALERT_DAILY_REPORT_TIME references in deploy-report playbook**

In `playbooks/08c-deploy-report.md`, the deploy report template references a stale env var `HOSTALERT_DAILY_REPORT_TIME` that no longer exists. The daily report time now comes from `host.host_alerter.daily_report` in `stack.yml`.

Update lines 119-127:

- Line 119: Change backup schedule from "3:00 AM UTC" to "3:00 AM" (timezone now comes from CRON_TZ)
- Line 121: Replace `<HOSTALERT_DAILY_REPORT_TIME>` with `<host.host_alerter.daily_report>` — instruct Claude to read the value from `stack.yml`
- Line 127: Replace `HOSTALERT_DAILY_REPORT_TIME` reference with `host.host_alerter.daily_report in stack.yml`

- [ ] **Step 4: Commit**

```bash
git add playbooks/04-vps1-openclaw.md playbooks/07-verification.md playbooks/08c-deploy-report.md
git commit -m "Add cronie prerequisite notes to playbooks, fix stale HOSTALERT_DAILY_REPORT_TIME refs"
```

---

### Task 6: Add CHANGELOG entry

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry**

Prepend after line 7 (`---`):

```markdown

## 2026-03-14 — Replace Vixie cron with cronie, add host.update_time.openclaw config

Vixie cron (Ubuntu default) ignores `CRON_TZ` in `/etc/cron.d/` files, causing all timezone-aware schedules to run in UTC instead of the configured timezone. cronie is a drop-in replacement with native `CRON_TZ` support and automatic DST handling.

**What changed:**
- `playbooks/02-base-setup.md`: added `cronie` to apt install list
- `stack.yml.example`: added `auto_update.openclaw` to `host` section
- `build/pre-deploy.mjs`: parses `host.update_time.openclaw`, resolves `{{CRON_TZ}}` in static cron templates
- `deploy/host/register-cron-jobs.sh`: auto-update cron uses configurable time and `CRON_TZ`
- `deploy/host/cron-openclaw-backup`: added `CRON_TZ` header
- `deploy/host/cron-openclaw-session-prune`: added `CRON_TZ` header

**Migration:**

1. Install cronie (replaces Vixie cron, preserves existing cron files):
   ```bash
   sudo apt install -y cronie
   ```

1. Verify cronie is active:

   ```bash
   dpkg -l cronie | grep '^ii' && systemctl status cronie
   ```

2. Add `host.auto_update.openclaw` to `stack.yml`:

   ```yaml
   host:
     host_alerter:
       daily_report: "9:30 AM PST"
     auto_update:
       openclaw: "3:00 AM PST"   # new — defaults to 3:00 AM PST if omitted
   ```

3. Rebuild and deploy:

   ```bash
   npm run pre-deploy
   scripts/sync-deploy.sh
   sudo bash <INSTALL_DIR>/host/register-cron-jobs.sh
   ```

---

```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "Add changelog for cronie migration and host.update_time.openclaw config"
```

---

### Task 7: Deploy and verify on VPS

- [ ] **Step 1: Install cronie on the VPS**

```bash
ssh <VPS> "sudo apt install -y cronie"
```

- [ ] **Step 2: Verify cronie replaced Vixie cron**

```bash
ssh <VPS> "dpkg -l cronie | grep '^ii' && systemctl status cronie"
```

- [ ] **Step 3: Rebuild and sync**

```bash
npm run pre-deploy
scripts/sync-deploy.sh
```

- [ ] **Step 4: Re-register cron jobs**

```bash
ssh <VPS> "sudo bash <INSTALL_DIR>/host/register-cron-jobs.sh"
```

- [ ] **Step 5: Verify CRON_TZ in all cron files**

```bash
ssh <VPS> "grep -r CRON_TZ /etc/cron.d/openclaw-*"
```

Expect: every cron file has a `CRON_TZ=America/Los_Angeles` line.

- [ ] **Step 6: Verify cron schedules**

```bash
ssh <VPS> "cat /etc/cron.d/openclaw-alerts /etc/cron.d/openclaw-auto-update /etc/cron.d/cron-openclaw-backup /etc/cron.d/cron-openclaw-session-prune"
```

Expect: all schedules in local time with `CRON_TZ` headers, auto-update at configured time.
