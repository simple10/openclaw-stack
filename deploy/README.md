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

## Files

| Source | VPS Target | Owner | Mode | Template |
|--------|-----------|-------|------|----------|
| `vector.yaml` | `/home/openclaw/openclaw/vector.yaml` | openclaw | 644 | No |
| `build-openclaw.sh` | `/home/openclaw/scripts/build-openclaw.sh` | openclaw | 755 | No |
| `entrypoint-gateway.sh` | `/home/openclaw/openclaw/scripts/entrypoint-gateway.sh` | openclaw | 755 | No |
| `host-alert.sh` | `/home/openclaw/scripts/host-alert.sh` | root | 755 | No |
| `docker-compose.override.yml` | `/home/openclaw/openclaw/docker-compose.override.yml` | openclaw | 644 | No |
| `openclaw.json` | `~/.openclaw/openclaw.json` | 1000:1000 | 600 | Yes |
| `models.json` | `~/.openclaw/agents/*/agent/models.json` | 1000:1000 | 600 | Yes |
