
  Current reality

  Tools are baked into the sandbox image at build time (entrypoint runs sandbox-toolkit.yaml installs). Three things make
  self-updating hard:

  1. Ephemeral filesystems — sandbox containers are destroyed after each task. An agent running npm update -g @openai/codex
  gets the new version for that session only. Next sandbox run reverts to the image-baked version.
  2. Network isolation — main agent sandbox runs with network: "none". It literally can't reach npm/GitHub to download
  anything. Skills agent has bridge networking, but most tool usage happens in the main agent.
  3. Image rebuild = gateway restart — the entrypoint builds sandbox images on boot. Updating a tool means restarting the
  entire gateway, which kills active sessions.

  Possible approaches

  A. Periodic image rebuilds (background, no restart)

  The gateway's inner dockerd could rebuild sandbox images on a timer (cron inside the container) without restarting the
  gateway process. New sandboxes pick up the fresh image; running ones are unaffected.

- Pro: Uses existing build pipeline, no architectural changes
- Con: Full rebuild is slow (all tools reinstall), wastes bandwidth, any build failure leaves stale image

  B. Persistent tool volume

  Mount a host directory (e.g., ./data/sandbox-tools/) through the chain: host → gateway → sandbox. npm globals, Go binaries,
  etc. install there instead of into the image. A separate update process refreshes them.

- Pro: Updates don't require image rebuild, instant for next sandbox
- Con: Needs careful PATH/prefix management, npm global prefix juggling is fragile, tool-specific install paths vary wildly
  (npm vs Go vs cargo vs brew)

  C. Thin update layer on sandbox start

  Sandbox entrypoint checks a "desired versions" manifest (a file on the bind mount) against installed versions. If stale, runs
   targeted npm install -g pkg@latest before handing control to the agent. Only works for tools with network access.

- Pro: Always current, targeted updates (not full rebuild)
- Con: Adds startup latency, doesn't work for network: "none" sandboxes, version check logic per package manager

  D. Split tools into "stable" and "fast-moving" tiers

  Keep system tools (ffmpeg, imagemagick, ripgrep) baked into the image. Move fast-moving AI CLI tools (claude-code, codex,
  opencode, amp) to a persistent npm prefix on a bind mount. A gateway-level cron job (which has network) runs npm update -g in
   that prefix periodically.

- Pro: Targeted — only fast-moving tools use the new mechanism. Stable tools stay simple.
- Con: Two installation paths to maintain

  My take

  Option D seems like the sweet spot. The practical implementation would be:

  1. Add a persistent bind mount for npm globals: ./data/sandbox-npm-global/ → gateway /opt/sandbox-npm-global/ → sandbox (same
   path)
  2. Fast-moving tools in sandbox-toolkit.yaml get a new flag (e.g., updatable: true) — installed into the persistent prefix
  instead of the image
  3. A lightweight update script runs on a timer inside the gateway (which has network access). It does
  NPM_CONFIG_PREFIX=/opt/sandbox-npm-global npm update -g for the updatable packages
  4. Sandbox PATH includes /opt/sandbox-npm-global/bin ahead of the image-baked paths

  The non-npm tools (opencode is also available via Go) would need per-ecosystem handling, though if they all offer npm
  packages that's the simplest common denominator.

  The main open question: should the agent itself be able to trigger an update (e.g., "update codex to latest"), or is
  background periodic updates sufficient? The former requires solving the network isolation problem for main agent sandboxes,
  which is a bigger architectural change.

  Want me to dig into implementing option D, or do you want to explore a different direction?
