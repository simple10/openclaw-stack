# Proposal: feat/matrix-channel — Matrix Channel Integration

**Status:** Implemented
**Branch:** `feat/matrix-channel`
**Depends on:** None
**Idempotency note:** In this context, "idempotent" means the change can be applied repeatedly without drift and can be introduced either before initial deployment or later on an existing deployment.

---

## Goal

Add Matrix as a supported messaging channel in `openclaw-stack`, using the existing OpenClaw Matrix plugin documented at:

`https://docs.openclaw.ai/channels/matrix`

OpenClaw supports Matrix via the `@openclaw/matrix` plugin. For this stack, the implementation work is plugin installation, channel configuration, persistence, and operator workflows.

---

## What Upstream Already Supports

Per the current OpenClaw docs and confirmed against a live installation, Matrix is:

- **Bundled with OpenClaw core** — `~/.openclaw/extensions/` is empty on a working Matrix install; no `plugins install` step needed
- Plugin key in `plugins.entries` is `"matrix"` (unscoped), not `"@openclaw/matrix"`
- Configured under `channels.matrix`
- Compatible with direct messages, rooms, threads, media, reactions, polls, location, and native commands
- Capable of E2EE when `channels.matrix.encryption: true` and the crypto module is available
- Able to run multiple Matrix accounts via `channels.matrix.accounts`

Important implication: this stack does not need to invent a Matrix transport layer, and does not need to manage plugin installation. It needs to make Matrix channel configuration first-class deployment concerns.

---

## Recommended Path

Implement Matrix in `openclaw-stack` using OpenClaw's native Matrix plugin and config model:

1. Activate the bundled `@openclaw/matrix` plugin via `plugins.entries.matrix.enabled` — no install step needed.
2. Expose Matrix credentials/config through `stack.yml` and `.env`.
3. Render `channels.matrix` into each instance's `openclaw.json`.
4. Persist Matrix runtime state so access tokens, sync state, and crypto state survive restarts.
5. Document DM pairing, room allowlists, and E2EE verification as operator workflows.

Implement Matrix through the official plugin and stack-managed configuration.

---

## Proposed Stack Design

### 1. Plugin activation

Matrix is bundled with OpenClaw core — no install step is needed. The `~/.openclaw/extensions/` directory remains empty on a working Matrix installation.

To activate the plugin, declare it in `plugins.entries` using the unscoped key `"matrix"`:

```jsonc
"plugins": {
  "entries": {
    "matrix": { "enabled": "${MATRIX_ENABLED}" }
  }
}
```

When `MATRIX_ENABLED=false`, the plugin entry remains in the config but the channel is inactive. When `MATRIX_ENABLED=true`, the channel starts on gateway boot — no restart of the entrypoint is needed beyond the normal container start.

### 2. Channel configuration

The stack should render OpenClaw's native Matrix config into `openclaw.json`, for example:

```jsonc
{
  "channels": {
    "matrix": {
      "enabled": true,
      "homeserver": "$MATRIX_HOMESERVER",
      "accessToken": "$MATRIX_ACCESS_TOKEN", // Access token for the Matrix account this claw uses as its bot-style identity
      "encryption": false,
      "dm": { "policy": "pairing" },
      "groupPolicy": "allowlist"
    }
  }
}
```

Optional E2EE sets `"encryption": true`.

### 3. Runtime persistence

The upstream docs state that Matrix stores credentials and sync/crypto state under `~/.openclaw`, including:

- `~/.openclaw/credentials/matrix/credentials.json`
- `~/.openclaw/matrix/accounts/...`

That means this proposal must account for persistent storage, especially for:

- Access-token backed sessions
- Sync state
- E2EE crypto state and device verification

This stack already persists the relevant `~/.openclaw` paths, so Matrix can reuse them without a new volume design.

Backup coverage should be extended to include:

- `~/.openclaw/matrix/`

E2EE should not be considered production-ready in this stack until backup/restore covers the Matrix crypto state under that tree.

### 4. Access-control model

The plugin's default Matrix DM behavior is `dm.policy = "pairing"`, which is a good operational default for this stack.

For rooms, upstream defaults are stricter than Telegram:

- `channels.matrix.groupPolicy = "allowlist"` by default
- Room allowlisting is configured via `channels.matrix.groups`
- Group sender allowlisting is configured via `channels.matrix.groupAllowFrom`
- Invites auto-join by default and can be restricted with `autoJoin` and `autoJoinAllowlist`

Matrix is not just "Telegram but different transport." It has a richer room and allowlist model that should be surfaced in stack config/docs.

### 5. Mental model: claws vs Matrix accounts

A claw is an OpenClaw gateway instance with its own domain, config, token, workspace, and runtime state.

A Matrix account is just one messaging identity that a claw can log in as.

For v1, the intended model is:

- one claw = one Matrix bot account
- one Matrix bot account can talk to multiple human Matrix users
- DMs are gated by pairing
- rooms are gated by allowlists and per-room policy

This is not a "one Matrix account per human user" design. Multiple people can use the same claw through the same bot account, subject to the claw's pairing and room policy.

Upstream supports multiple Matrix accounts per claw. In this stack, the normal and intended relationship is one Matrix account per claw, and that is the model used by this proposal.

---

## Required Changes

### `stack.yml.example`

Add a top-level per-claw `matrix:` section, parallel to `telegram:`, and map it to upstream `channels.matrix`. Example:

```yaml
defaults:
  matrix:
    enabled: false
    homeserver: "https://matrix.org"
    dm_policy: pairing
    dm_allow_from: []
    group_policy: allowlist
    encryption: false
    groups:
      # "!roomid:matrix.org":
      #   enabled: true
      #   mention_only: true
    group_allow_from: []
    auto_join: always
    auto_join_allowlist: []

claws:
  main:
    matrix:
      enabled: true
      access_token: ${MAIN_CLAW_MATRIX_ACCESS_TOKEN} # Access token for the Matrix account this claw logs in as
```

This matches the repo's current config style and deep-merge behavior. The render step can translate it into upstream fields such as `dm.policy`, `groupPolicy`, `groupAllowFrom`, and `autoJoin`.

Default resolution:

- `defaults.matrix.homeserver` should provide the normal stack-wide default
- individual claws may override it with `claws.<name>.matrix.homeserver`
- per-claw override is only needed when different claws intentionally use different homeservers

Room identity:

- stack config should use canonical Matrix room IDs such as `!roomid:matrix.org`
- room aliases such as `#room:matrix.org` may help operators discover rooms, but the stack should render and persist canonical room IDs to avoid alias-resolution ambiguity

### `.env.example`

Add per-claw access-token credentials following the stack's existing naming pattern:

```env
MAIN_CLAW_MATRIX_ACCESS_TOKEN=
# Optional if homeserver differs per claw:
# MAIN_CLAW_MATRIX_HOMESERVER=https://matrix.org
```

Use access-token auth only in this stack. The rendered container env can still expose `MATRIX_HOMESERVER` and `MATRIX_ACCESS_TOKEN`, but stack inputs should follow the per-claw naming pattern already used elsewhere in this repo. Multi-account support is not part of this stack model and does not need a flat env-var scheme.

`MAIN_CLAW_MATRIX_ACCESS_TOKEN` is only an example. The actual env var name depends on the claw name, such as `ALERTS_CLAW_MATRIX_ACCESS_TOKEN`.
This token belongs to the Matrix account the claw uses as its bot-style identity, not to the homeserver itself.

This proposal is about the claw's interactive Matrix identity. If Matrix is later used for host/infrastructure alerts, that should use a separate Matrix sender identity, separate access token, and likely a separate room configuration rather than reusing the claw's chat identity.

### `openclaw.jsonc` template

Render `channels.matrix` only when enabled, and pass through supported options such as:

- `enabled`
- `homeserver`
- `accessToken`
- `encryption`
- `dm.policy`
- `dm.allowFrom`
- `groupPolicy`
- `groupAllowFrom`
- `groups`
- `autoJoin`
- `autoJoinAllowlist`

### Deploy/install scripts

No plugin install step is needed in the entrypoint or elsewhere. Matrix is bundled and activated through config (`plugins.entries.matrix.enabled`).

The entrypoint requires no Matrix-specific changes. The plugin is loaded by the OpenClaw gateway process on startup when the `plugins.entries.matrix` entry is enabled.

### `docker-compose.yml.hbs`

Add Matrix env vars to each claw service so `openclaw.json` can resolve them via env substitution at startup.

Required env wiring:

```yaml
{{#if this.matrix.enabled}}
- MATRIX_HOMESERVER={{this.matrix.homeserver}}
- MATRIX_ACCESS_TOKEN={{this.matrix.access_token}}
{{/if}}
```

These env vars should only be emitted when Matrix is enabled for that claw.

Implementation note:

- Ensure the claw-service Handlebars context exposes `this.matrix` in the same way it already exposes other per-claw settings such as `this.telegram`

### Docs

Add operator documentation covering:

- Creating a Matrix bot account
- Obtaining an access token
- Understanding that the claw's Matrix access token is for interactive chat, not for a separate infra-alert sender
- DM pairing approval with `openclaw pairing list matrix` and `openclaw pairing approve matrix <CODE>`
- Inviting the bot to a room before room usage
- How `auto_join` and `auto_join_allowlist` affect room invites
- How allowed rooms are represented in stack config
- Whether mention-gating is enabled for room interactions
- Room allowlisting and mention-gating
- E2EE verification flow
- Beeper-specific note: requires E2EE enabled

### Validation rules

Add pre-deploy and startup validation for these cases:

- `matrix.enabled: true` requires `matrix.homeserver`
- `matrix.enabled: true` requires `matrix.access_token`
- `npm run pre-deploy` should fail before rendering deploy artifacts if required Matrix config is missing
- `npm run pre-deploy` should fail if the resolved per-claw secret (for example `MAIN_CLAW_MATRIX_ACCESS_TOKEN`) is unset while Matrix is enabled for that claw
- `matrix.encryption: true` emits a clear warning or hard failure if crypto support is unavailable

### Restart behavior

Matrix install and config should follow the stack's current reload model:

- First-time Matrix enablement requires a gateway restart because plugin loading is not hot-reloadable
- Subsequent `channels.matrix` config changes may be hot-reloadable if they are treated as ordinary channel config by OpenClaw
- Any `plugins.*` change still requires restart

---

## Operational Notes

### DM behavior

Matrix DMs default to pairing approval, which is appropriate for this stack's security posture.

Relevant upstream commands:

```bash
openclaw pairing list matrix
openclaw pairing approve matrix <CODE>
```

Initial operator flow:

1. Deploy the claw with Matrix enabled and valid access token.
2. Send the first DM to the bot account from a Matrix client.
3. Review pending Matrix pairings with `openclaw pairing list matrix`.
4. Approve the intended user/device with `openclaw pairing approve matrix <CODE>`.

### Rooms and mention-gating

Rooms are handled as group sessions. Upstream defaults to `groupPolicy: "allowlist"` and supports per-room config, sender allowlists, and mention gating. This should be surfaced directly in stack configuration and operator docs.

Initial operator flow:

1. Invite the bot account to the room.
2. Ensure the room is allowed by the claw's Matrix config.
3. If `auto_join` is restricted, ensure the room or inviter is in the appropriate allowlist.
4. If mention-gating is enabled for that room policy, address the bot explicitly when sending commands.

### E2EE

Matrix E2EE is supported, but it introduces operational requirements:

- Crypto module must be available
- The bot/device must be verified from another Matrix client
- Crypto state must persist across restarts
- Rotating access tokens creates a new device store and may require re-verification
- Token rotation is an operator action followed by redeploy, not a deploy-script feature
- Token rotation should not imply OpenClaw user re-pairing, but it may require Matrix-side device re-verification in encrypted rooms

Recommendation: support `encryption: false` first as the baseline deployment path, but design persistence correctly so `encryption: true` is a safe follow-up rather than a redesign.

Release gate for production E2EE:

- v1 may expose `matrix.encryption`
- production-ready E2EE requires backup/restore coverage for `~/.openclaw/matrix/`
- until that backup coverage is implemented and verified, encrypted Matrix should be treated as supported with operational caution rather than the baseline production mode

### Multi-account

Upstream supports multiple Matrix accounts per claw, but that is not part of this stack's intended model.

For this stack, the normal model is one Matrix account per claw, and that is the model used in this proposal. Multi-account support is optional and remains out of scope for v1.

---

## Idempotency

Matrix integration should remain fully idempotent in the deployment sense:

- **Before initial deployment:** enable Matrix in config, provide credentials, deploy once
- **After deployment:** add Matrix config, run the normal deploy flow, and let the stack configure the channel
- **Repeat deploys:** re-running deploy should not duplicate plugin state or require cleanup
- **Disable later:** turning Matrix off should stop channel startup without affecting unrelated OpenClaw state

Clarification:

- "Can be added before or after deployment" is one consequence of idempotency here
- The stronger meaning is that the same deploy action can be safely re-applied and converge on the intended state

---

## Implementation Constraints

### Plugin model

`@openclaw/matrix` is bundled with OpenClaw and does not live in `~/.openclaw/extensions/`. The plugin key in `plugins.entries` is `"matrix"` (unscoped). No version pinning, no install path, no extensions directory management.

If a future OpenClaw version moves Matrix to an external plugin, the entrypoint install pattern can be reintroduced at that time.

### Runtime persistence

Matrix runtime persistence is already satisfied by the current stack design.

Reasoning:

- Each claw bind-mounts `instances/<name>/.openclaw` into `/home/node/.openclaw`
- Setup scripts create and persist that directory on the host
- Matrix credentials, sync state, and crypto state live under that persisted tree

Remaining follow-up:

- Extend host backups to include Matrix account state under `.openclaw/matrix/`

### Migration and drift

The stack should define expected behavior for claws that already have manual Matrix state.

Cases to handle:

- Existing Matrix credentials and sync state already present under `~/.openclaw`
- Existing claw config updated from "no Matrix" to stack-managed Matrix

Expected behavior:

- The stack reuses existing persisted Matrix state where valid
- Deploy converges config without deleting valid runtime state
- Validation surfaces mismatches clearly rather than silently overwriting them

Mismatch handling:

- Persisted credentials exist and configured access token differs: treat the configured token as source of truth, reuse existing state where possible, and warn that Matrix device/session state may need re-verification
- Persisted sync/crypto state exists and homeserver changes: warn clearly and treat this as a migration-risk change that may require a fresh Matrix session or re-sync
- Persisted plugin/state exists but Matrix is now disabled in stack config: do not delete runtime state automatically; disable startup only

Reset boundaries:

- If the homeserver changes, existing Matrix sync/crypto state should be treated as invalid and the implementation should require a fresh Matrix session rather than silently reusing the old state
- If the configured access token changes and the persisted Matrix session cannot authenticate cleanly, the implementation should prompt for a fresh Matrix session reset rather than silently looping on bad state
- If Matrix is disabled, persisted state should be left on disk unless the operator explicitly removes it

Reset mechanism:

- v1 does not need a dedicated reset command in the proposal
- implementation should at minimum fail clearly and tell the operator that the persisted Matrix session/state must be reset before proceeding
- a dedicated reset command or helper script can be added later if reset handling becomes common enough to justify it

### `stack.yml` shape

Use a top-level per-claw `matrix:` block, parallel to `telegram:`, and render it into upstream `channels.matrix`.

Reasoning:

- Matches current repo config conventions
- Works cleanly with deep-merge defaults
- Keeps stack operator config concise
- Still maps cleanly onto upstream Matrix settings

### Multi-account scope

Initial implementation should expose only the default Matrix account. Multiple Matrix accounts per claw are possible upstream, but that is not part of this stack's intended model.

Reasoning:

- One Matrix bot identity per claw matches the stack's current operating model
- Multi-account support adds nested secrets, routing choices, and more operator complexity
- It is useful, but not necessary for initial Matrix support

### E2EE scope for v1

Initial implementation should expose E2EE config, but unencrypted Matrix should remain the baseline supported path.

Reasoning:

- Upstream supports both encrypted and unencrypted Matrix
- E2EE adds device verification, recovery, and backup complexity
- The current stack persistence model is sufficient for runtime use, but backup coverage should be extended before encrypted recovery is considered fully operationally mature
- This keeps v1 practical without painting the design into a corner

---

## Conclusion

The implementation integrates Matrix into `openclaw-stack` through config and env-var wiring only. No plugin install step is needed — the plugin is bundled with OpenClaw and activated via `plugins.entries.matrix.enabled`. The stack's job is channel configuration, credential management, and persistence coverage.
