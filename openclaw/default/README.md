# Default Claw Config

Default openclaw.jsonc template used when a claw doesn't specify its own `openclaw_json` path in stack.yml.

JSONC (JSON with Comments) is used for the source template — comments are stripped during pre-deploy
and the output is saved as `.deploy/instances/<name>/.openclaw/openclaw.json`.

`$VAR` references are resolved at container startup by entrypoint envsubst.
Docker env vars are set by docker-compose.yml (the single source of truth for what config values flow into the container).

To customize for a specific claw:
1. Copy this file to `openclaw/<claw-name>/openclaw.jsonc`
2. Set `openclaw_json: openclaw/<claw-name>/openclaw.jsonc` in that claw's stack.yml section
