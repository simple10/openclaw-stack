# 00 - Analysis Mode

Analyze existing VPS deployments to determine current state and verify implementations.

## Critical Rule

**NEVER make modifications during analysis.** This mode is strictly read-only.

- Run verification commands only (status checks, file reads, service queries)
- Do not fix issues, even obvious ones, without first getting user approval
- Do not create, edit, or delete any files on the VPS
- Do not restart services or modify configurations
- Record all findings, then ask the user what to do

If you discover issues, present them to the user and wait for explicit direction before making any changes.

## Overview

Use this playbook when connecting to VPSs that may already have OpenClaw deployed. Analysis mode runs verification checks without making changes.

## When to Use

- New conversation with existing VPSs
- After manual changes were made outside of Claude
- To verify deployment health
- Before implementing new features on existing infrastructure

## Prerequisites

- SSH access to target VPS(s)
- `openclaw-config.env` configured with VPS IPs

---

## Analysis Process

### 1. Determine Scope

Ask the user:

> "What should I analyze?"
>
> - **Full analysis** - Analyze VPS-1 (all playbooks)
> - **Single playbook** - Verify specific playbook only

If single playbook, ask which one.

### 2. Run Verification

**For base playbooks (01-06):**

- Use `07-verification.md` verification commands
- These are designed to check the core deployment holistically

**For networking playbooks:**

- Use section 7.4 in `07-verification.md`

**For single playbook verification:**

- Base playbooks 01-06: Use relevant sections from `07-verification.md`
- All others: Use the playbook's own Verification section

---

## After Analysis

Present findings grouped by playbook with pass/fail status. List any issues found with expected vs. actual state. Ask the user what to do before making any changes.

---

## Single Playbook Verification

When verifying a single playbook, run only that playbook's verification checks and report results with pass/fail for each check. Ask before fixing issues.

---

## Notes

- Analysis mode is read-only - no changes are made
- Always ask before making fixes
