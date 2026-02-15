# Plan: Documentation Consistency & Conciseness Cleanup

## Context

CLAUDE.md, REQUIREMENTS.md, and 12 playbook files have accumulated duplicated content, conflicting instructions from outdated extras playbook, and verbose commentary. This makes it harder for Claude to follow the docs reliably — when the same information appears in 3 places with slight differences, it's unclear which is authoritative.

**Goal:** Single source of truth for each piece of information. Compact commentary. Remove conflicts.

---

## Principles

- **REQUIREMENTS.md** = authoritative technical reference (architecture, config specs, design decisions, gotchas)
- **CLAUDE.md** = orchestration & user interaction (setup flow, execution order, quick reference)
- **Playbooks** = step-by-step execution (commands to run, in order)
- Each piece of info lives in ONE place; others link to it

---

## Changes by File

### 1. CLAUDE.md

**1a. Remove Security Model section (lines 326-340)**
Duplicates REQUIREMENTS.md 2.2 and 02-base-setup.md. Replace with:

```
See [REQUIREMENTS.md § 2.2](REQUIREMENTS.md#22-two-user-security-model) for the two-user security model.
```

**1b. Remove Security Checklist (lines 362-391)**
Duplicates 07-verification.md § 7.6. Replace with:

```
See [07-verification.md § 7.6](playbooks/07-verification.md) for the full security checklist.
```

**1c. Compact Setup Question Flow (lines 88-249)**
This is 162 lines. Reduce to ~80 lines by:

- Remove blockquote formatting (the `>` prompt templates) — Claude can construct natural prompts
- Collapse CF_TUNNEL_TOKEN instructions to a brief note + link to docs
- Collapse SSH troubleshooting to 3 lines (not a full quoted prompt)
- Remove Path A/B heading hierarchy, use flat bullet structure

**1d. Compact Quick Reference (lines 271-322)**
Remove the Workers subsection (lines 310-322) — this duplicates 01-workers.md and the agent doesn't need copy-paste worker deploy commands in CLAUDE.md.

**1e. Compact General Rules CLI wrapper entry (line 47)**
Currently 4 sentences. Reduce to 2: host wrapper + container symlink + always use `--user node`.

---

### 2. REQUIREMENTS.md

**2a. Remove full config file contents that duplicate playbooks**
These sections contain the exact same configs that playbooks write via `tee`:

- § 3.4: Remove full docker-compose.override.yml content (already in 04 § 4.6). Keep the rationale table only.
- § 3.7: Remove full openclaw.json content (already in 04 § 4.8). Keep the rationale table only.
- § 3.10: Remove full vector.yaml and compose snippet (already in 04 § 4.7). Keep the rationale table and field list.
- § 3.14: Remove full .env variable table (already in 04 § 4.5). Keep only the gotcha about port format.

For each, add a note: "See playbook 04-vps1-openclaw.md § X.X for the full config."

**2b. Compact § 6 Known Issues**
Currently 50 lines with many single-bullet subsections. Merge related items:

- Combine "Security & Access" into a single compact list
- Combine "Build & Patching" items (some repeat the same info as § 3.6)
- Remove items that are just restating what's already in the relevant section (e.g., the `read_only: false` gotcha is already explained in § 3.4)

**2c. Remove duplicate Docker daemon.json content**
§ 2.8 contains the full daemon.json + rationale table. 03-docker.md has the identical JSON + a near-identical table. Keep the JSON in REQUIREMENTS.md (authoritative reference), remove the "Configuration Explained" table from 03-docker.md (link to REQUIREMENTS instead).

---

### 3. `playbooks/02-base-setup.md`

**3a. Remove security model explanation (lines 64-74)**
The two-user model is explained in 3 places. Keep the user/sudo table (useful context for the commands below) but remove the "Security Benefits" paragraph — it's in REQUIREMENTS.md § 2.2.

**3b. Merge § 2.5 into § 2.4**
§ 2.5 "Verify SSH Port Change and Remove Port 22" is a follow-up step to § 2.4 "SSH Hardening". Merge them — the separate section adds no value and the "IMPORTANT: Test before removing" note fits naturally at the end of § 2.4.

---

### 4. `playbooks/03-docker.md`

**4a. Remove "Configuration Explained" table (lines 96-109)**
Near-duplicate of REQUIREMENTS.md § 2.8 rationale table. Replace with:

```
See [REQUIREMENTS.md § 2.8](../REQUIREMENTS.md#28-docker) for setting rationale.
```

**4b. Remove "Security Notes" section (lines 173-179)**
Restates what's already in the Configuration Explained table (which we're also removing) and REQUIREMENTS.md. Remove entirely.

---

### 5. `playbooks/04-vps1-openclaw.md`

**5a. Compact § 4.8 config preamble (lines 358-387)**
30-line comment block before the openclaw.json `tee`. Reduce to ~8 lines — keep the essential warnings (reject unknown keys, bind:lan reason, trustedProxies exact-IP-only, device pairing CLI commands) but remove the verbose explanations that duplicate REQUIREMENTS.md.

**5b. Remove § 4.8b entirely (lines 515-522)**
"Build-Time Patches (Reference)" is 8 lines that just restate what § 4.8a already says. Remove it.

**5c. Compact § 4.8c entrypoint preamble (lines 525-540)**
16-line description of what the entrypoint does. The entrypoint script itself has inline comments. Reduce to a 3-line summary and let the script comments speak for themselves.

**5d. Add known-issue note about sandbox-common build (near lines 656-667)**
The entrypoint calls `sandbox-common-setup.sh` which has a confirmed upstream bug: its heredoc Dockerfile inherits `USER sandbox` from the base image and runs `apt-get` without `USER root`, causing silent failure. Add a comment in the entrypoint noting this is a known issue to be addressed separately. No fallback logic — keep the entrypoint simple.

Add a note like:

```bash
      # Known issue: upstream sandbox-common-setup.sh doesn't add USER root before
      # apt-get. The base image sets USER sandbox, so this build will fail silently.
      # TODO: Fix upstream or patch the script. See notes/sandbox-common-bug.md
```

**5e. Compact Security Notes section (lines 988-997)**
Several items restate what's already in the compose override comments and REQUIREMENTS.md. Reduce to 3-4 key points.

---

### 6. `playbooks/extras/sandbox-and-browser.md`

**6a. Replace duplicated entrypoint script (lines 89-249) with reference**
The extras entrypoint is a 160-line copy of 04's version (with a fallback that we're removing). Replace with a short reference:

```
The entrypoint script is defined in `04-vps1-openclaw.md` § 4.8c. It includes sandbox
bootstrap, Docker daemon startup, Claude sandbox build, and privilege drop.

If the entrypoint on VPS-1 is outdated, redeploy it from § 4.8c.
```

**6b. Remove E.2a sed-based compose updates (lines 256-295)**
These `sed` commands patch `user: 1000:1000` → `0:0`, `read_only: true` → `false`, etc. But 04 § 4.6 already writes the compose override with these values. This section is only needed if upgrading from a pre-sandbox deployment. Mark it clearly as "Upgrade only — skip if running a fresh deployment from current playbook 04."

**6c. Remove E.4 start_period update (lines 368-378)**
04 § 4.6 already sets `start_period: 300s`. This section is obsolete for fresh deployments. Same treatment as 6b.

**6d. Compact E.3 config explanation (lines 298-365)**
The JSON snippet + "Key decisions" block (lines 306-353) largely duplicates 04 § 4.8 and REQUIREMENTS.md § 3.7. Replace with a reference to 04 § 4.8 and keep only the brief note about what's being added.

---

### 7. `playbooks/01-workers.md`

**7a. Remove duplicate verification section (lines 220-234)**
The "Verification" section at the end repeats the same health check + test ingestion commands from § 1.1 and § 1.2 verify steps. Remove it — inline verification is sufficient.

**7b. Remove "Future Extensions" section (lines 276-280)**
Speculative features that don't belong in a deployment playbook. Remove.

---

### 8. `playbooks/07-verification.md`

**8a. Compact § 7.8 Security Verification preamble (lines 212-214)**
3-line explanation of why this matters. Reduce to 1 line — the section title is self-explanatory.

**8b. Compact `openclaw doctor` expected warnings (lines 259-266)**
The explanation of why the "lan binding" warning is safe is already in REQUIREMENTS.md § 3.7 and 04 § 4.5 comments. Reduce to 1 line + link.

---

### 9. `playbooks/00-analysis-mode.md`

**9a. Remove verbose example output blocks (lines 88-106, 119-135)**
Two template output blocks (20+ lines each) showing what findings look like. Claude doesn't need output templates. Reduce each to a 2-line instruction: "Present findings grouped by playbook with pass/fail status."

---

### 10. `playbooks/06-backup.md`

**10a. Remove "Storage Convention" note (lines 135-137)**
Duplicates CLAUDE.md General Rules about bind mounts. Remove, or replace with: "See CLAUDE.md General Rules."

**10b. Compact "Off-Site Backup" section (lines 209-232)**
24 lines for optional future work. Reduce to 5 lines with brief rclone/rsync examples.

---

### 11. `playbooks/README.md`

No changes needed — already concise.

### 12. `playbooks/maintenance.md`

No changes needed — already well-structured and non-duplicative.

### 13. `playbooks/08-post-deploy.md`

**13a. Compact § 8.5 "Device Pairing Reference" box (lines 200-236)**
ASCII art reference card (37 lines). Replace with a compact markdown block (~10 lines).

---

## Summary of Line Impact (Estimated)

| File | Current Lines | Estimated After | Saved |
|------|--------------|-----------------|-------|
| CLAUDE.md | 392 | ~310 | ~80 |
| REQUIREMENTS.md | 829 | ~620 | ~210 |
| 02-base-setup.md | 427 | ~400 | ~27 |
| 03-docker.md | 180 | ~150 | ~30 |
| 04-vps1-openclaw.md | 998 | ~950 | ~48 |
| extras/sandbox-and-browser.md | 570 | ~380 | ~190 |
| 01-workers.md | 281 | ~260 | ~21 |
| 07-verification.md | 344 | ~330 | ~14 |
| 00-analysis-mode.md | 143 | ~110 | ~33 |
| 06-backup.md | 241 | ~215 | ~26 |
| 08-post-deploy.md | 263 | ~235 | ~28 |
| **Total** | **~4668** | **~3960** | **~710** |

---

## Verification

After all changes:

1. `grep -r 'read_only' playbooks/` — should show consistent `false` everywhere
2. `grep -r 'user:.*0:0\|user:.*1000:1000' playbooks/` — should show consistent `0:0`
3. `grep -r 'start_period' playbooks/` — should show consistent `300s`
4. Verify no broken cross-references: search for `§` references and confirm target sections exist
5. Read through each modified file to confirm no steps were accidentally removed
