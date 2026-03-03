# Plan: Merge `.env.local` into `.env`

## Context

`.env.local` was introduced to keep auto-generated secrets (passwords, tokens) separate from user-managed config in `.env`. In practice this adds complexity — two files to reason about, a resolution hierarchy (`.env` > `.env.local` > generate), and extra sourcing logic — without meaningful benefit since both are gitignored local files. Merging into `.env` simplifies the mental model: one file, one source of truth.

## What changes

### 1. `build/pre-deploy.mjs` — Remove `.env.local` read/write, append to `.env`

- **Delete** `readEnvLocal()` and `writeEnvLocal()` functions (~lines 93-111)
- **Add** an `appendToEnv(vars)` function that upserts auto-generated vars at the bottom of `.env` under a `# Auto-generated` section header
- **Simplify** protected var resolution (~lines 493-512): check `env[name]` (already loaded from `.env`), else generate — no `.env.local` fallback needed since generated values now persist in `.env`
- **Simplify** per-claw gateway token resolution (~lines 545-555): same approach — check `.env`, else generate, then upsert into `.env`

### 2. `build/update-env.mjs` — Always target `.env`

- **Remove** the protected-var routing logic (~line 79-80) that directs writes to `.env.local`
- All vars written to `.env` via the existing `upsertEnvVar()` function

### 3. `deploy/host/source-config.sh` — Remove `.env.local` sourcing block

- **Delete** the conditional `.env.local` source block (~lines 54-63)
- Everything is already in `.env`, which is sourced earlier in the same script

### 4. `.gitignore` — Remove `.env.local` entry

- Delete the `.env.local` line (line 7)

### 5. `.env.example` — Update documentation

- Remove the "protected vars stored in `.env.local`" note (~lines 18-21)
- Add a comment in the auto-generated section explaining these are managed by `pre-deploy`

### 6. Playbooks — Update references (documentation only)

- `playbooks/maintenance.md` (~lines 15, 79, 81) — update token rotation instructions
- `playbooks/01-workers.md`, `playbooks/02-base-setup.md`, `playbooks/08c-deploy-report.md` — update any `.env.local` mentions (these reference vars via `source-config.sh` which will still work, but any prose mentioning `.env.local` needs updating)

### 7. Existing `.env.local` migration

- After all code changes, the user's current `.env.local` values need to be appended to `.env`. Running `npm run pre-deploy` will handle this naturally (it reads `.env`, finds missing protected vars, generates/reuses them, and appends to `.env`). But since the values already exist in `.env.local`, we should do a one-time migration: read `.env.local`, append its values to `.env`, then delete `.env.local`.

## Files to modify

| File | Change |
|------|--------|
| `build/pre-deploy.mjs` | Remove `readEnvLocal`/`writeEnvLocal`, add `appendToEnv`, simplify resolution |
| `build/update-env.mjs` | Remove protected-var file routing, always write to `.env` |
| `deploy/host/source-config.sh` | Remove `.env.local` sourcing block |
| `.gitignore` | Remove `.env.local` line |
| `.env.example` | Update docs |
| `playbooks/maintenance.md` | Update `.env.local` references |
| `playbooks/01-workers.md` | Update `.env.local` references if any |
| `playbooks/02-base-setup.md` | Update `.env.local` references if any |
| `playbooks/08c-deploy-report.md` | Update `.env.local` references if any |

## Verification

1. Run `npm run pre-deploy` — should resolve all protected vars from `.env` and append any missing ones
2. Confirm `.env` contains the auto-generated section with correct values
3. Run `source deploy/host/source-config.sh` — confirm all vars are available
4. Grep for any remaining `.env.local` references
