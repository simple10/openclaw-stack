# Plan: Remove extras directory and make deployment batteries-included

## Context

The `playbooks/extras/` directory currently holds one playbook (`sandbox-and-browser.md`) that's already integrated into `04-vps1-openclaw.md`. The extras concept adds unnecessary complexity — users are asked to choose optional features during setup, but the goal is a single batteries-included deployment with no optional steps.

## Changes

### 1. Delete `playbooks/extras/` directory

- `playbooks/extras/README.md`
- `playbooks/extras/sandbox-and-browser.md`

### 2. Update `CLAUDE.md`

- **Lines 29-35**: Remove the "Optional features" table and `extras/README.md` link
- **Lines 114-115 (Step 1: Deployment Type)**: Remove extras mentions:
  - New deployment: Remove "plus optional extras" — just confirm VPS IP, domain, and proceed
  - Existing deployment: Remove "select extras" from Modify option — just "describe custom changes"

### 3. Update `playbooks/README.md`

- **Lines 31-33**: Remove the "Optional Features" section entirely

### 4. Update `README.md`

- **Line 24**: Change "Asks you for any missing config values and optional extras" → "Asks you for any missing config values"

### 5. Update `playbooks/00-analysis-mode.md`

- **Lines 59-81**: Remove the "For optional features" verification block and "Detect Optional Features" section (section 3). The sandbox image check (`docker images | grep openclaw-sandbox-common`) is already covered by `07-verification.md`'s doctor check.

### 6. Update `playbooks/07-verification.md`

- **Line 266**: Change `extras/sandbox-and-browser.md` reference → point to `04-vps1-openclaw.md` troubleshooting instead (since that's where the sandbox build logic lives)

### 7. Update `playbooks/04-vps1-openclaw.md`

- **Line 613**: Change comment from `See extras/sandbox-and-browser.md troubleshooting` → remove or update to reference the troubleshooting section within 04 itself

### Not touched

- `plans/` directory — historical/implemented plans, leave as-is

## Verification

- `grep -r "extras" playbooks/ CLAUDE.md README.md` returns no matches
- `ls playbooks/extras/` returns "No such file or directory"
