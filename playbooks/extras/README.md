# Optional Features

This directory contains optional playbooks that enhance the deployment but are not required for core functionality.

## What Are Optional Features?

Optional features are enhancements that:

- Add convenience or additional capabilities
- Are not required for OpenClaw to function
- Can be added after initial deployment
- May have external dependencies (accounts, services)

## Difference from Base Playbooks

| Aspect | Base Playbooks (`01-07`) | Optional Features (`extras/`) |
|--------|--------------------------|-------------------------------|
| Required | Yes | No |
| Execution order | Sequential, numbered | Any time after deployment |
| Dependencies | Build on each other | Require base deployment complete |
| Naming | `XX-name.md` | `name.md` (no number) |

## Available Optional Features

| Feature | Playbook | Description |
|---------|----------|-------------|
| Sandbox & Browser | [`sandbox-and-browser.md`](sandbox-and-browser.md) | Rich sandbox (Node.js, git, dev tools, ffmpeg, imagemagick, Claude Code CLI), browser (Chromium + noVNC) |

## Adding Optional Features

To plan and implement a new optional feature, use plan mode to design the feature based on existing playbooks as templates.
