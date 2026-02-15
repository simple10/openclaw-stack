> now analyze CLAUDE.md and the playbooks/*. go step by step starting at the beginning and look for ways to
> optimize the content. Remove unneccessary redundancies. Carefully look for any contradictions or incorrect
> commands. Look for ways to run tasks in parallel.
>
> During the last deploy, claude had to compact the conversation leading to a signification slow down. The main
> culprit was the oauth token setup step in post-deploy reference a script that caused a full scan of the project
> source. Hopefully this won't happen again. We need to make sure the playbooks are as clear and concise to get the
> best possible results
>

# Plan: Optimize Playbooks for Context Efficiency

## Context

During the first deploy, Claude's context window compacted mid-execution, causing significant slowdown. The main culprit was the OAuth setup referencing a script that triggered a full project scan (fixed in previous commit). But the playbooks still total **3,782 lines** across 11 files, with substantial redundancy. The top 3 files alone (`04-vps1-openclaw.md` 974 lines, `02-base-setup.md` 539 lines, `07-verification.md` 517 lines) account for 54% of all content.

Goal: reduce total line count, eliminate redundancies, add parallelization hints, and fix any contradictions — all to minimize context pressure during a full deploy run.

## Changes

### 1. Consolidate models.json 3x repeat in `04-vps1-openclaw.md` § 4.8

**Lines 346-388** repeat the exact same block 3 times for `main`, `code`, and `skills` agents. Replace with a single loop.

**Before:** 3 separate blocks (~42 lines)
**After:** 1 loop block (~16 lines)
**Savings:** ~26 lines

```
for agent in main code skills; do
  sudo mkdir -p /home/openclaw/.openclaw/agents/${agent}/agent
  # SOURCE + tee + chown + chmod (one block)
done
```

### 2. Condense 07-verification.md § 7.5c (VPS Resource Check)

**Lines 256-313** (58 lines) duplicate 90% of `00-fresh-deploy-setup.md` § 0.4. Replace with a condensed version that references § 0.4 for the full procedure and only adds the post-deploy-specific behavior (docker inspect comparison, auto-apply during fresh deploy).

**Target:** ~30 lines (down from 58)
**Savings:** ~28 lines

### 3. Remove duplicate Cloudflare domain routing check in `07-verification.md` § 7.4

**Lines 159-197** (39 lines) repeat the curl-based Cloudflare Access check from `00-fresh-deploy-setup.md` § 0.5, including identical error messages and debug steps. Since § 0.5 already ran before deployment, § 7.4 only needs to confirm routing works (not re-explain Cloudflare Access setup).

**After:** Keep the curl commands (~8 lines) + "If unprotected/failing, see 00-fresh-deploy-setup.md § 0.5" reference.
**Savings:** ~20 lines

### 4. Merge 07-verification.md § 7.6 + § 7.8 (security sections)

§ 7.6 (Security Checklist, 56 lines) and § 7.8 (Security Verification, 58 lines) overlap — both check port binding, both verify external reachability. Merge into a single § 7.6 Security Verification section.

**Savings:** ~30 lines

### 5. Condense 08-post-deploy.md § 8.4 Approach 3

**Lines 164-191** describe the file-based pairing approach but say "run the Python approval script from 04-vps1-openclaw.md §4.9". This cross-reference forces Claude to re-read a 974-line file to find a 45-line Python script. Instead, keep Approach 3 self-contained with a brief inline description (the steps are already listed — just clarify step 3).

Replace the vague "run the Python approval script from §4.9" with the actual command:

```bash
ssh ... "sudo python3 -c '
import json, time, os
# ... (inline the script)
'"
```

This prevents Claude from re-scanning `04-vps1-openclaw.md` during post-deploy. The tradeoff is ~20 lines of duplication vs forcing a re-read of a 974-line file. **Net context savings are strongly positive** since the alternative is re-reading the entire playbook.

### 6. Condense CLAUDE.md Service Management section

**Lines 108-137** (30 lines) show 9 nearly identical docker compose command examples. Replace with a pattern + 3 examples.

**Before:** 30 lines of examples
**After:** ~15 lines (pattern template + key examples + restart vs up -d note)
**Savings:** ~15 lines

### 7. Deduplicate restart vs up -d notes in `maintenance.md`

Lines 35-36 and 72-73 each explain restart vs up -d. Replace with a one-line reference to CLAUDE.md.

**Savings:** ~6 lines

### 8. Add parallelization hints to playbooks

Add brief `<!-- PARALLEL -->` comments in playbooks where Claude should batch independent SSH commands into a single session. Key locations:

- **02-base-setup.md:** § 2.5 (swap), § 2.6 (fail2ban), § 2.7 (auto-updates), § 2.8 (kernel) can run in a single SSH session after § 2.4 completes
- **04-vps1-openclaw.md:** § 4.5-4.8 config file writes can be batched into a single SSH session
- **07-verification.md:** § 7.1-7.3 health checks can run in parallel (VPS checks via SSH, worker checks via local curl)

Format: Add a note at the start of parallelizable sections:

```
> **Batch:** Steps 4.5 through 4.8 write independent config files. Execute all file writes in a single SSH session.
```

### 9. Fix incorrect/inconsistent commands

**a. `maintenance.md` line 56:** AI Gateway Auth Token rotation says to rebuild the image (`build-openclaw.sh`) — but rotating the auth token only needs `docker compose up -d` to pick up the new .env value, not a full image rebuild. The build step is unnecessary and misleading. Remove `sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh` from that rotation procedure.

**b. `07-verification.md` § 7.5c line 310:** Uses `scp -P` (uppercase P for port) which is correct for scp but inconsistent with `ssh -p` (lowercase) everywhere else. Not a bug, but add a comment to prevent confusion.

## Files to modify

| File | Changes | Est. savings |
|------|---------|-------------|
| `playbooks/04-vps1-openclaw.md` | Consolidate models.json loop, add batch hint for §4.5-4.8 | ~26 lines |
| `playbooks/07-verification.md` | Condense §7.5c, trim §7.4, merge §7.6+§7.8 | ~78 lines |
| `playbooks/08-post-deploy.md` | Inline Approach 3 Python script reference | ~0 (tradeoff) |
| `CLAUDE.md` | Condense service management section | ~15 lines |
| `playbooks/maintenance.md` | Dedup restart notes, fix auth token rotation | ~8 lines |
| `playbooks/02-base-setup.md` | Add batch hint | ~2 lines added |

**Total estimated reduction: ~145 lines** (~4% of total), but the real win is eliminating cross-file re-reads that trigger much larger context consumption.

## What I'm NOT changing

- **00-fresh-deploy-setup.md**: Already well-sized (260 lines), contains the canonical resource check and Cloudflare verification that other files should reference.
- **01-workers.md**: Compact (214 lines), two similar but not identical worker deploy flows.
- **03-docker.md**: Already minimal (175 lines).
- **06-backup.md**: Compact (233 lines), minor redundancy not worth the edit churn.
- **00-analysis-mode.md**: Small (81 lines), different use case (not part of deploy flow).
- **File references**: All verified correct — no broken references.
- **SSH command format**: Varies intentionally (pre-hardening uses port 22/ubuntu, post-hardening uses port 222/adminclaw). Not worth standardizing since each context is correct.

## Verification

1. Read each modified file and confirm no broken cross-references
2. Confirm models.json loop produces correct paths for all 3 agents
3. Confirm merged security section in 07-verification.md covers all original checklist items
4. Count total lines across all playbooks + CLAUDE.md — target < 3,650 (down from 3,782)
