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

## Files

| Source | VPS Target | Owner | Mode |
|--------|-----------|-------|------|
| `vector.yaml` | `/home/openclaw/openclaw/vector.yaml` | openclaw | 644 |
| `build-openclaw.sh` | `/home/openclaw/scripts/build-openclaw.sh` | openclaw | 755 |
| `host-alert.sh` | `/home/openclaw/scripts/host-alert.sh` | root | 755 |
