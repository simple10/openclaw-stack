// Parse human-readable schedule time → cron expression + IANA timezone.
//
// Accepts:
//   "9:30 AM PST"                 — 12-hour with TZ abbreviation
//   "9:30 AM America/Los_Angeles" — 12-hour with full IANA name
//   "9:30 AM"                     — 12-hour, no timezone (uses VPS host timezone)
//   "16:30 UTC"                   — 24-hour with timezone
//   "16:30"                       — 24-hour, no timezone
//
// Returns: { cronExpr: string, ianaTz: string }
//   cronExpr: 5-field cron expression (e.g. "30 9 * * *")
//   ianaTz:   IANA timezone string, or empty string if omitted (falls back to VPS host timezone)
//
// Throws on invalid input (bad format, out-of-range hours/minutes).
// Unknown timezone abbreviations are non-fatal (warns, returns empty ianaTz).

import { TZ_ABBREVIATIONS } from './tz-abbreviations.mjs'

// Optional warn function — caller can override for custom logging
let warnFn = (msg) => console.error(`[warn] ${msg}`)

export function setWarnFn(fn) {
  warnFn = fn
}

export function parseScheduleTime(timeStr, label = 'schedule') {
  if (!timeStr) return { cronExpr: '', ianaTz: '' }

  const str = String(timeStr).trim()

  // Try 12-hour format: "3:15 PM" or "3:15 PM PST" or "3:15 PM America/Los_Angeles"
  const match12 = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+(.+))?$/i)
  if (match12) {
    let hour = parseInt(match12[1], 10)
    const minute = parseInt(match12[2], 10)
    const ampm = match12[3].toUpperCase()
    const tzPart = match12[4]?.trim() || ''

    if (hour < 1 || hour > 12) {
      throw new Error(`Invalid hour ${hour} in ${label} "${timeStr}" — 12-hour format requires 1-12`)
    }
    if (minute > 59) {
      throw new Error(`Invalid minute ${minute} in ${label} "${timeStr}" — must be 0-59`)
    }

    if (ampm === 'PM' && hour !== 12) hour += 12
    if (ampm === 'AM' && hour === 12) hour = 0

    return { cronExpr: `${minute} ${hour} * * *`, ianaTz: resolveTz(tzPart, label) }
  }

  // Try 24-hour format: "16:30" or "16:30 UTC" or "16:30 Asia/Tokyo"
  const match24 = str.match(/^(\d{1,2}):(\d{2})(?:\s+(.+))?$/)
  if (match24) {
    const hour = parseInt(match24[1], 10)
    const minute = parseInt(match24[2], 10)
    const tzPart = match24[3]?.trim() || ''

    if (hour > 23) {
      throw new Error(`Invalid hour ${hour} in ${label} "${timeStr}" — 24-hour format requires 0-23`)
    }
    if (minute > 59) {
      throw new Error(`Invalid minute ${minute} in ${label} "${timeStr}" — must be 0-59`)
    }

    return { cronExpr: `${minute} ${hour} * * *`, ianaTz: resolveTz(tzPart, label) }
  }

  throw new Error(`Could not parse ${label} time "${timeStr}" — expected format: "H:MM AM/PM [TZ]" or "H:MM [TZ]"`)
}

function resolveTz(tzPart, label) {
  if (!tzPart) return ''

  // Full IANA name (contains /) — use directly
  if (tzPart.includes('/')) return tzPart

  const ianaTz = TZ_ABBREVIATIONS[tzPart.toUpperCase()] || ''
  if (!ianaTz) {
    warnFn(`Unknown timezone "${tzPart}" in ${label} — schedule will use VPS host timezone`)
  }
  return ianaTz
}
