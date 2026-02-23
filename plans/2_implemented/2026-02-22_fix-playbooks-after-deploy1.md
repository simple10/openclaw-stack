# Fix Playbook Issues Found During Deployment

## Context

During a fresh deployment on 2026-02-22, several playbook issues caused subagent confusion or wasted effort. These are documentation/playbook fixes only — no deployed code changes.

## Changes

### 1. Add UID warning to `playbooks/04-vps1-openclaw.md` § 4.3 (~line 153)

**Problem:** A subagent saw `chown -R 1000:1000` and "corrected" it to `chown openclaw:openclaw` (UID 1002), breaking container access.

**Fix:** Add a prominent warning callout before the chown commands explaining that 1000:1000 is intentional (container's node user UID), NOT the openclaw user UID. This prevents subagents from "fixing" it.

---

### 2. Simplify CLI pairing in `playbooks/04-vps1-openclaw.md` § 4.16 (~line 715)

**Problem:** The 4-step CLI pairing procedure (trigger pending → Python file manipulation → approve → verify) is unnecessary. The `openclaw` host wrapper and all `docker exec` commands bypass WebSocket device pairing — no CLI pairing is needed.

**Fix:** Replace the "Pair the CLI" subsection with a short note explaining that docker exec bypasses WebSocket auth, so CLI pairing is not needed. Keep the `chown` fix (still needed for gateway-created dirs) and the verify step. Also update `08-post-deploy.md` line 126 which says "The CLI was auto-paired during deployment."

**Files:** `playbooks/04-vps1-openclaw.md`, `playbooks/08-post-deploy.md`

---

### 3. Update plugin section in `playbooks/04-vps1-openclaw.md` § 4.13 (~lines 544-595)

**Problem:** Section title says "Deploy Skill Router Plugin" but the `skill-router` plugin no longer exists. It was superseded by the `coordinator` plugin. Actual plugins in `deploy/plugins/` are `coordinator/` and `telemetry/`.

**Fix:** Rewrite section 4.13:

- Title: "Deploy Plugins" (drop "Skill Router")
- Description: reference `coordinator` (auto-discovers routes from agent configs, writes routing table to AGENTS.md) and `telemetry` (unified event shipping)
- Update the "add a new skill" instructions to reference `agents.list[].skills` arrays in `openclaw.json` — the coordinator reads these automatically
- Keep the SCP procedure (generic, works for any plugins)

---

### 4. Add skip guard to `playbooks/04-vps1-openclaw.md` § 4.15 (~line 618)

**Problem:** Section describes deploying hooks from `deploy/hooks/`, but the directory is empty. The `scp -r deploy/hooks/*` command fails with "no matches found."

**Fix:** Add: `> **Skip this section** if deploy/hooks/ is empty (no hook subdirectories). The entrypoint handles the empty case gracefully.`

---

### 5. Add verification checkpoint to `playbooks/00-fresh-deploy-setup.md` § 0.7 (~line 260)

**Problem:** During automated deployment, VPS-side verification from `07-verification.md` was skipped — only local checks ran. The automation directive doesn't explicitly require running it.

**Fix:** Add a bullet to the "Only stop if" list in the automation directive: `- **07-verification.md:** Delegate full VPS-side checks to a subagent. Report the summary table before proceeding to 08-post-deploy.md.`

---

## Files Modified

| File | Sections |
|------|----------|
| `playbooks/04-vps1-openclaw.md` | 4.3, 4.13, 4.15, 4.16 |
| `playbooks/08-post-deploy.md` | 8.4 (line 126) |
| `playbooks/00-fresh-deploy-setup.md` | 0.7 |

## Verification

- Grep for `skill-router` in active playbooks — should have zero matches (only in `plans/` history)
- Grep for `auto-paired` in 08-post-deploy.md — should reflect the new wording
- Read modified sections to confirm accuracy
