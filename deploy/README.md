# Deploy Files

Authoritative source files for VPS deployment. Playbooks reference these
via `# SOURCE:` comments — never duplicate file contents in playbook heredocs.

## Convention

When a playbook bash block contains:

```
# SOURCE: deploy/<file> → /vps/target/path
```

The executor reads `deploy/<file>` from this repo and deploys its contents
to the target path on the VPS. The heredoc body contains a sentinel
`# <<< deploy/<file> >>>` as a placeholder.

### Templates

Files marked `(template)` in the SOURCE comment use `{{VAR}}` placeholders
(Mustache-style). The executor substitutes values from the deployment config
before writing to the VPS.

```
# SOURCE: deploy/<file> (template) → /vps/target/path
# VARS: VAR_NAME (source description)
```

The `# VARS:` comment documents which placeholders exist and where their
values come from. Template syntax:

- `{{VAR}}` — replaced with the variable's value at deploy time
- `{{VAR}}` is visually distinct from Docker Compose `${VAR}` interpolation
  and shell `$VAR` expansion, avoiding ambiguity

## Deployment Scripts

Scripts in `deploy/scripts/` are SCP'd to the VPS and executed remotely. They
keep large bash out of playbook inline blocks (and out of the LLM context
window), improving deployment reliability.

| Script | Playbook | Purpose |
|--------|----------|---------|
| `scripts/setup-infra.sh` | 04 §4.2 | Creates Docker networks, directories, clones repo, generates `.env` |
| `scripts/deploy-config.sh` | 04 §4.3 | Copies config files, substitutes templates, sets permissions, creates crons |

Both scripts use `set -euo pipefail`, send progress to stderr, and emit a
single machine-parseable line on stdout (`OPENCLAW_GENERATED_TOKEN=<hex>` or
`DEPLOY_CONFIG_OK`). Config values are passed as environment variables.
