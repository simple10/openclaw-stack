# Plan: Optimize subagent context loading

## Context

Subagents during deployment load unnecessary content — the full CLAUDE.md (174 lines) including orchestration-only sections, plus entire playbooks even when they only need specific sections. This wastes context and slows startup. Two targeted changes trim the fat.

## Changes

### 1. Trim CLAUDE.md orchestration sections (~35 lines saved per subagent)

The Setup Question Flow (lines 61-74) and Execution Order (lines 78-97) are only used by the main agent during initial orchestration. By the time subagents launch, these decisions are already made. Both are fully covered in `00-fresh-deploy-setup.md`.

**Action:** Collapse both into brief one-line references to `00-fresh-deploy-setup.md`.

**File:** `CLAUDE.md`

- Replace Setup Question Flow section (14 lines) with: `See [00-fresh-deploy-setup.md](playbooks/00-fresh-deploy-setup.md) for the setup question flow and deployment validation.`
- Replace Execution Order section (20 lines) with: `See [00-fresh-deploy-setup.md](playbooks/00-fresh-deploy-setup.md) § 0.7 for execution order, automation directive, and context window management.`

### 2. Add line ranges to subagent prompts in 00-fresh-deploy-setup.md

The biggest waste is playbook 04 (700 lines). A subagent doing 4.1-4.2 reads all 700 lines but only needs ~160. Adding `offset`/`limit` guidance to the subagent prompt template saves ~500 lines per 04 subagent.

**File:** `playbooks/00-fresh-deploy-setup.md` — Context window management section

Update the example subagent prompt template and delegation table to include recommended read ranges:

```
| Step | Playbook | Read range |
|------|----------|------------|
| 01: Workers | 01-workers.md | Full (273 lines) |
| 02: Base setup | 02-base-setup.md | Full (617 lines) |
| 04: Infra + config (4.1–4.3) | 04-vps1-openclaw.md | Lines 1–262 |
| 04: Build + start (4.4) | 04-vps1-openclaw.md | Lines 263–445 |
```

Add a note: "Use `offset` and `limit` parameters when telling subagents to read playbook sections. This prevents subagents from reading troubleshooting, updating, and verification sections they don't need."

## Files modified

- `CLAUDE.md` — Collapse 2 sections to references
- `playbooks/00-fresh-deploy-setup.md` — Add read ranges to subagent guidance

## Verification

- Confirm CLAUDE.md still has all essential rules (General Rules, Configuration, Quick Reference, Security)
- Confirm the collapsed sections' content is fully covered in `00-fresh-deploy-setup.md`
- Check that the line ranges in the delegation table match actual section boundaries via `grep -n '^## '`
