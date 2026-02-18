/**
 * Minimal terminal TUI primitives — raw mode, ANSI, key parsing, frame rendering.
 * Zero dependencies.
 */

// ─── Raw mode ────────────────────────────────────────────────────────────────

export function enterAltScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[?25l")
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
}

export function exitAltScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1049l")
  process.stdin.setRawMode?.(false)
  process.stdin.pause()
}

export function termSize(): [cols: number, rows: number] {
  return [process.stdout.columns ?? 80, process.stdout.rows ?? 24]
}

// ─── ANSI codes ──────────────────────────────────────────────────────────────

export const RESET = "\x1b[0m"
export const BOLD = "\x1b[1m"
export const DIM = "\x1b[2m"
export const INVERT = "\x1b[7m"
export const RED = "\x1b[31m"
export const GREEN = "\x1b[32m"
export const YELLOW = "\x1b[33m"
export const BLUE = "\x1b[34m"
export const MAGENTA = "\x1b[35m"
export const CYAN = "\x1b[36m"
export const GRAY = "\x1b[90m"

/** Wrap text in ANSI style codes. */
export function st(text: string, ...codes: string[]): string {
  return codes.length ? codes.join("") + text + RESET : text
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

/** Pad string to width, accounting for ANSI codes. */
export function pad(str: string, w: number): string {
  const vis = stripAnsi(str).length
  return vis >= w ? str : str + " ".repeat(w - vis)
}

// ─── Key parsing ─────────────────────────────────────────────────────────────

export type Key =
  | { name: "up" | "down" | "left" | "right" | "enter" | "escape" | "tab" | "pageup" | "pagedown" | "home" | "end" }
  | { name: "char"; ch: string }
  | { name: "ctrl"; ch: string }
  | { name: "unknown" }

export function parseKey(buf: Buffer): Key {
  if (buf.length === 1) {
    const b = buf[0]
    if (b === 3) return { name: "ctrl", ch: "c" }
    if (b === 9) return { name: "tab" }
    if (b === 13) return { name: "enter" }
    if (b === 27) return { name: "escape" }
    if (b === 127) return { name: "ctrl", ch: "h" }
    if (b < 32) return { name: "ctrl", ch: String.fromCharCode(b + 96) }
    return { name: "char", ch: buf.toString() }
  }
  const s = buf.toString()
  if (s === "\x1b[A") return { name: "up" }
  if (s === "\x1b[B") return { name: "down" }
  if (s === "\x1b[C") return { name: "right" }
  if (s === "\x1b[D") return { name: "left" }
  if (s === "\x1b[5~") return { name: "pageup" }
  if (s === "\x1b[6~") return { name: "pagedown" }
  if (s === "\x1b[H" || s === "\x1b[1~") return { name: "home" }
  if (s === "\x1b[F" || s === "\x1b[4~") return { name: "end" }
  // Unknown escape sequences (mouse events, etc.) — ignore, don't treat as Escape.
  // Real Escape is a single byte (0x1b) handled above.
  if (s.startsWith("\x1b")) return { name: "unknown" }
  return { name: "char", ch: s }
}

// ─── Frame rendering ─────────────────────────────────────────────────────────

/** Overwrite entire screen without clearing (flicker-free). */
export function renderFrame(lines: string[], cols: number, rows: number): void {
  let out = "\x1b[H"
  for (let i = 0; i < rows; i++) {
    out += pad(i < lines.length ? lines[i] : "", cols)
    if (i < rows - 1) out += "\r\n"
  }
  process.stdout.write(out)
}
