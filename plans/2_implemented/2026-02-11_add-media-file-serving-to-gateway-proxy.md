# Plan: Add media file serving to the gateway proxy

## Context

Agents save media files (browser screenshots, PDFs, downloads) to `~/.openclaw/media/` inside the gateway container. The webchat UI doesn't render these — it shows the user an absolute file path like `/home/node/.openclaw/media/browser/abc123.png`, which is useless since that path is inside the container on the VPS.

The existing `deploy/novnc-proxy.mjs` (port 6090) already runs inside the gateway and is reachable via the Cloudflare tunnel. We can extend it to also serve static files from the media directory.

**Current media directory** (inside container): `/home/node/.openclaw/media/`

```
media/
└── browser/
    ├── abc123.png    (screenshots)
    ├── def456.jpg
    └── ghi789.pdf
```

Files are UUID-named, written only by the gateway's browser tool (not by sandbox agents). The directory is already behind the Cloudflare tunnel + Access auth.

## Changes

### 1. Modify: `deploy/novnc-proxy.mjs`

Add a `/media/*` route before the `/<agent-id>/*` VNC routing. This serves static files from the media directory.

**New URL routing** (additions in bold):

- `GET /` → index page (add media section link)
- **`GET /media/` → directory listing of media files**
- **`GET /media/<path>` → serve static file from `~/.openclaw/media/<path>`**
- `GET /<agent-id>/` → noVNC redirect (unchanged)
- `GET /<agent-id>/*` → VNC proxy (unchanged)

**Implementation details:**

- Import `node:fs` (`stat`, `createReadStream`), `node:path`
- Media root: `/home/node/.openclaw/media`
- **Path traversal protection**: resolve the path, verify it starts with media root (prevents `../../etc/passwd`)
- **No symlink following**: use `lstat` instead of `stat` to reject symlinks
- **MIME types**: minimal map (`png→image/png`, `jpg/jpeg→image/jpeg`, `pdf→application/pdf`, `gif→image/gif`, `webp→image/webp`, fallback `application/octet-stream`)
- **Security headers**: `X-Content-Type-Options: nosniff`
- **Directory listing** at `/media/` and `/media/browser/`: simple HTML page listing files with links, sorted by modification time (newest first). Subdirectories shown as links too.
- Stream files (don't buffer) using `createReadStream` for memory efficiency

**Update index page** (`/`): Add a "Media Files" link to the existing index page, pointing to `/media/`.

### 2. Rename script (optional consideration)

The script is no longer just a noVNC proxy — it's a general-purpose gateway utility server. However, renaming means updating the entrypoint, compose volume mount, and docs. **Skip the rename** — the comment at the top of the file already documents its routing, and adding media serving is a natural extension.

## Files summary

| File | Change |
|------|--------|
| `deploy/novnc-proxy.mjs` | Add `/media/*` static file serving + directory listing (~50 lines) |

No compose or entrypoint changes needed — the media directory is already accessible inside the container (it's under `~/.openclaw/` which is bind-mounted).

## Verification

```bash
# 1. Serve a known media file
sudo docker exec openclaw-gateway curl -sI http://127.0.0.1:6090/media/browser/<uuid>.png
# Expect: 200, Content-Type: image/png, X-Content-Type-Options: nosniff

# 2. Directory listing
sudo docker exec openclaw-gateway curl -s http://127.0.0.1:6090/media/
# Expect: HTML page listing browser/ subdirectory

# 3. Path traversal blocked
sudo docker exec openclaw-gateway curl -sI http://127.0.0.1:6090/media/../openclaw.json
# Expect: 403

# 4. External access via tunnel
# Open https://openclaw-vnc.ventureunknown.com/media/ in browser
```
