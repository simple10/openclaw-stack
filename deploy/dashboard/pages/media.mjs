// pages/media.mjs — Media browser page handler for the OpenClaw dashboard.
// Serves directory listings wrapped in layout chrome and streams individual
// files for download. Supports path traversal protection and symlink rejection.

import { createReadStream, readdirSync, lstatSync } from 'node:fs'
import { resolve, extname, join } from 'node:path'
import { getEffectiveBP } from '../auth.mjs'
import { renderPage } from '../layout.mjs'

const MEDIA_ROOT = '/home/node/.openclaw/media'

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

export function handleRequest(req, res, subPath) {
  const basePath = getEffectiveBP()
  const relPath = decodeURIComponent(subPath) || '/'
  const resolved = resolve(MEDIA_ROOT, relPath.startsWith('/') ? relPath.slice(1) : relPath)

  // Path traversal protection
  if (!resolved.startsWith(MEDIA_ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  let stat
  try {
    stat = lstatSync(resolved)
  } catch {
    if (resolved === MEDIA_ROOT || resolved.startsWith(MEDIA_ROOT + '/')) {
      const html = renderPage({
        title: 'Media Files',
        bodyHtml: `<h1 style="color:var(--textStrong);margin-bottom:8px">Media Files</h1>
         <p><a href="${basePath}/" style="color:var(--accent)">&larr; Back to dashboard</a></p>
         <p class="empty">No media files yet. Media files appear here when agents capture screenshots or download files.</p>`,
        basePath,
      })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  // Reject symlinks
  if (stat.isSymbolicLink()) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  // Directory listing
  if (stat.isDirectory()) {
    const urlPath = `${basePath}/media${subPath}`.replace(/\/+$/, '')
    const html = directoryPage(resolved, urlPath, basePath)
    if (!html) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Error reading directory')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  // Serve file
  const mime = MIME_TYPES[extname(resolved).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(resolved).pipe(res)
}

// Also export for home page media preview
export function getRecentMedia(limit = 5) {
  const basePath = getEffectiveBP()
  try {
    const entries = readdirSync(MEDIA_ROOT)
      .map(name => {
        try {
          const stat = lstatSync(join(MEDIA_ROOT, name))
          if (stat.isSymbolicLink() || stat.isDirectory()) return null
          return { name, size: stat.size, mtimeMs: stat.mtimeMs, ext: extname(name).toLowerCase() }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)

    return entries.map(e => ({
      name: e.name,
      size: formatSize(e.size),
      sizeBytes: e.size,
      ext: e.ext,
      modified: e.mtimeMs,
      url: `${basePath}/media/${encodeURIComponent(e.name)}`,
    }))
  } catch {
    return []
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function directoryPage(dirPath, urlPath, basePath) {
  let entries
  try {
    entries = readdirSync(dirPath)
      .map((name) => {
        try {
          const stat = lstatSync(join(dirPath, name))
          if (stat.isSymbolicLink()) return null
          return { name, isDir: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs }
        } catch { return null }
      })
      .filter(Boolean)
  } catch { return null }

  const dirs = entries.filter((e) => e.isDir).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const files = entries.filter((e) => !e.isDir).sort((a, b) => b.mtimeMs - a.mtimeMs)

  const prefix = urlPath.endsWith('/') ? urlPath : urlPath + '/'
  const rows = [
    ...dirs.map(e => `<tr class="dr"><td class="w">&#128193; <a href="${prefix}${e.name}/" style="color:var(--accent)">${e.name}/</a></td><td>&mdash;</td><td></td></tr>`),
    ...files.map(e => `<tr class="dr"><td class="w">&#128196; <a href="${prefix}${e.name}" style="color:var(--accent)">${e.name}</a></td><td>${formatSize(e.size)}</td><td><a href="${prefix}${e.name}" download class="dl" style="color:var(--accent)">&#8681;</a></td></tr>`),
  ]

  const mediaRoot = basePath + '/media'
  const parentLink = urlPath === mediaRoot ? `${basePath}/` : urlPath.replace(/\/[^/]+\/?$/, '/')
  const body = `<h1 style="color:var(--textStrong);margin-bottom:8px">Media Files &mdash; ${urlPath.replace(mediaRoot, '') || '/'}</h1>
     <p style="margin-bottom:16px"><a href="${parentLink}" style="color:var(--accent)">&larr; Back</a></p>
     ${rows.length === 0
       ? '<p class="empty">No files yet. Media files appear here when agents capture screenshots or download files.</p>'
       : `<div class="glass panel media-listing" style="overflow-x:auto"><table class="dtable">
       <thead><tr><th>Name</th><th>Size</th><th></th></tr></thead>
       <tbody>${rows.join('\n')}</tbody>
     </table></div>`
     }`

  return renderPage({ title: 'Media Files', bodyHtml: body, basePath })
}
