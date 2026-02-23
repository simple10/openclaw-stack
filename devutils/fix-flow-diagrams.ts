#!/usr/bin/env bun
/**
 * fix-flow-align.ts
 *
 * Fixes vertical alignment in text/ascii diagrams inside markdown code blocks.
 * Handles two diagram styles:
 *   1. Flow/sequence diagrams: columns of | pipes that should align vertically
 *   2. Box diagrams: box-drawing borders (│┐┘) where the right edge should align
 *
 * Root cause: LLMs count bytes or JS string length instead of display width,
 * so multi-byte Unicode chars (─ │ → ❌ ✅) cause columns to drift by 1-2 positions.
 *
 * Usage:
 *   bun run fix-flow-align.ts <file-or-directory>
 *
 * When given a directory, only scans .md files (recursive).
 */

import { readdir, stat, readFile, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

// ---------------------------------------------------------------------------
// Display width calculation
// ---------------------------------------------------------------------------

/**
 * Get the visual display width of a single Unicode code point.
 *
 * Terminal display width rules (simplified):
 * - ASCII: width 1
 * - Box drawing (U+2500-U+257F): width 1 (but 3 bytes UTF-8)
 * - Arrows (U+2190-U+21FF): width 1
 * - Most misc symbols/dingbats: width 1
 * - Emoji with default emoji presentation (❌ ✅ etc): width 2
 * - CJK ideographs: width 2
 * - Fullwidth forms: width 2
 * - Zero-width joiners, variation selectors, combining marks: width 0
 */
function charDisplayWidth(codePoint: number): number {
  // Zero-width characters
  if (
    codePoint === 0x200b || // ZWSP
    codePoint === 0x200c || // ZWNJ
    codePoint === 0x200d || // ZWJ
    codePoint === 0xfeff // BOM
  ) {
    return 0
  }

  // Variation selectors and combining marks
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff)
  ) {
    return 0
  }

  // Supplementary emoji (U+1F300-U+1F9FF, U+1FA00-U+1FAFF): width 2
  if (
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa00 && codePoint <= 0x1faff)
  ) {
    return 2
  }

  // Emoji with default emoji presentation in the BMP
  // These specific code points render as wide emoji in most terminals
  const wideEmoji = new Set([
    0x2614,
    0x2615, // umbrella, hot beverage
    0x2648,
    0x2649,
    0x264a,
    0x264b,
    0x264c,
    0x264d, // zodiac
    0x264e,
    0x264f,
    0x2650,
    0x2651,
    0x2652,
    0x2653,
    0x267f, // wheelchair
    0x2693, // anchor
    0x26a1, // high voltage
    0x26aa,
    0x26ab, // circles
    0x26bd,
    0x26be, // sports
    0x26c4,
    0x26c5, // snowman, sun behind cloud
    0x26ce, // ophiuchus
    0x26d4, // no entry
    0x26ea, // church
    0x26f2,
    0x26f3, // fountain, golf
    0x26f5, // sailboat
    0x26fa, // tent
    0x26fd, // fuel pump
    0x2705, // ✅ white heavy check mark
    0x2708,
    0x2709, // airplane, envelope
    0x270a,
    0x270b, // fist, hand
    0x270f, // pencil
    0x2712, // black nib
    0x2714, // ✔ heavy check mark
    0x2716, // ✖ heavy multiplication x
    0x271d, // latin cross
    0x2721, // star of david
    0x2728, // sparkles
    0x2733,
    0x2734, // eight spoked asterisk
    0x2744, // snowflake
    0x2747, // sparkle
    0x274c, // ❌ cross mark
    0x274e, // cross mark outline
    0x2753,
    0x2754,
    0x2755, // question marks, exclamation
    0x2757, // ❗ exclamation mark
    0x2763,
    0x2764, // heart exclamation, heart
    0x2795,
    0x2796,
    0x2797, // plus, minus, divide
    0x27a1, // right arrow (emoji presentation)
    0x27b0, // curly loop
  ])

  if (wideEmoji.has(codePoint)) {
    return 2
  }

  // Everything else in U+2190-U+27BF: width 1
  // (arrows, math, technical, box drawing, block elements, geometric, misc symbols, dingbats)
  if (codePoint >= 0x2190 && codePoint <= 0x27bf) {
    return 1
  }

  // CJK ranges: width 2
  if (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f)
  ) {
    return 2
  }

  // Fullwidth forms: width 2
  if (codePoint >= 0xff01 && codePoint <= 0xff60) {
    return 2
  }

  // Halfwidth forms: width 1
  if (codePoint >= 0xff61 && codePoint <= 0xffdc) {
    return 1
  }

  return 1
}

/** Calculate display width of a string. */
function displayWidth(str: string): number {
  let width = 0
  for (const char of str) {
    width += charDisplayWidth(char.codePointAt(0)!)
  }
  return width
}

// ---------------------------------------------------------------------------
// Diagram detection
// ---------------------------------------------------------------------------

const BOX_VERTICAL = new Set([...'│┃┆┇┊┋'])
const BOX_CORNERS_RIGHT = new Set([...'┐┑┒┓┤┥┦┧┨┩┪┫╗╖╕╣'])
const BOX_CORNERS_LEFT = new Set([...'┌┍┎┏├┝┞┟┠┡┢┣╔╓╒╠'])
const BOX_BOTTOM_RIGHT = new Set([...'┘┙┚┛╝╜╛┴┵┶┷┸┹┺┻╧╨╩'])
const BOX_BOTTOM_LEFT = new Set([...'└┕┖┗╚╙╘'])
const ALL_RIGHT_EDGE = new Set([...BOX_VERTICAL, ...BOX_CORNERS_RIGHT, ...BOX_BOTTOM_RIGHT])

function looksLikeBoxDiagram(lines: string[]): boolean {
  let boxLines = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const chars = [...trimmed]
    const first = chars[0]
    const last = chars[chars.length - 1]
    const hasLeftBorder =
      BOX_VERTICAL.has(first) || BOX_CORNERS_LEFT.has(first) || BOX_BOTTOM_LEFT.has(first)
    const hasRightBorder = ALL_RIGHT_EDGE.has(last)
    if (hasLeftBorder && hasRightBorder) boxLines++
  }
  return boxLines >= 3
}

function looksLikeFlowDiagram(lines: string[]): boolean {
  let pipeLines = 0
  let arrowLines = 0
  for (const line of lines) {
    if (line.includes('|')) pipeLines++
    if (/[─\-]=*>|<[─\-]=*|──|->|<-/.test(line)) arrowLines++
  }
  return pipeLines >= 3 && arrowLines >= 1
}

// ---------------------------------------------------------------------------
// Box diagram alignment
// ---------------------------------------------------------------------------

/** All characters that can appear as a right/vertical edge in a box */
const ALL_BOX_CHARS_SET = new Set([
  ...'│┃┆┇┊┋┐┑┒┓┤┥┦┧┨┩┪┫╗╖╕╣┘┙┚┛╝╜╛┴┵┶┷┸┹┺┻╧╨╩┌┍┎┏├┝┞┟┠┡┢┣╔╓╒╠└┕┖┗╚╙╘─━═┬┭┮┯┰┱┲┳┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏║╤╥╦╪╫╬',
])

/**
 * Find display-width positions of all right-edge box chars on a line.
 * Returns array of { pos, char } for each right-edge char found.
 */
function findBoxEdgePositions(line: string): { pos: number; char: string }[] {
  const results: { pos: number; char: string }[] = []
  let w = 0
  for (const ch of line) {
    if (ALL_RIGHT_EDGE.has(ch)) {
      results.push({ pos: w, char: ch })
    }
    w += charDisplayWidth(ch.codePointAt(0)!)
  }
  return results
}

/**
 * Cluster positions into alignment groups with awareness of co-occurring
 * positions on the same line.
 *
 * Two positions cannot be in the same group if they both appear on the
 * same line. This prevents nesting levels (e.g., │  │ with edges at
 * positions 46 and 49) from being merged into one group.
 *
 * Returns map from each observed position → target position.
 */
function clusterPositions(lineEdgePositions: number[][], maxGap: number = 2): Map<number, number> {
  // Collect all unique positions and their frequencies
  const allPositions: number[] = []
  for (const edges of lineEdgePositions) {
    for (const pos of edges) allPositions.push(pos)
  }
  if (allPositions.length === 0) return new Map()

  const positionCounts = new Map<number, number>()
  for (const pos of allPositions) {
    positionCounts.set(pos, (positionCounts.get(pos) || 0) + 1)
  }

  // Build a "cannot merge" set: pairs of positions that appear on the same line
  const cannotMerge = new Set<string>()
  for (const edges of lineEdgePositions) {
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const [a, b] = [edges[i], edges[j]].sort((x, y) => x - y)
        cannotMerge.add(`${a},${b}`)
      }
    }
  }

  // Sort unique positions
  const sorted = [...new Set(allPositions)].sort((a, b) => a - b)

  // Greedy clustering: walk through sorted positions, extend current group
  // only if within maxGap AND not conflicting with any existing group member
  const groups: number[][] = []
  let currentGroup: number[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const pos = sorted[i]
    const prevPos = sorted[i - 1]

    // Check if this position can join the current group
    let canJoin = pos - prevPos <= maxGap

    if (canJoin) {
      // Also check: does this position co-occur on any line with any group member?
      for (const member of currentGroup) {
        const [a, b] = [member, pos].sort((x, y) => x - y)
        if (cannotMerge.has(`${a},${b}`)) {
          canJoin = false
          break
        }
      }
    }

    if (canJoin) {
      currentGroup.push(pos)
    } else {
      groups.push(currentGroup)
      currentGroup = [pos]
    }
  }
  groups.push(currentGroup)

  // For each group, target = the mode (most frequent position)
  const mapping = new Map<number, number>()
  for (const group of groups) {
    let bestPos = group[0]
    let bestCount = 0
    for (const pos of group) {
      const count = positionCounts.get(pos) || 0
      if (count > bestCount) {
        bestCount = count
        bestPos = pos
      }
    }
    for (const pos of group) {
      mapping.set(pos, bestPos)
    }
  }

  return mapping
}

/**
 * Fix alignment of a box diagram using column-based alignment.
 *
 * Strategy (multi-pass):
 * 1. Find all right-edge box char positions across all lines
 * 2. Cluster nearby positions into alignment groups
 * 3. For each group, determine target position (mode)
 * 4. Rebuild each line, adjusting the whitespace/dashes between box chars
 *    so each right-edge char lands on its target column
 */
function fixBoxAlignment(lines: string[]): string[] {
  // Step 1: Collect all right-edge positions across all lines
  const lineEdges: { pos: number; char: string }[][] = []
  const lineEdgePositions: number[][] = []

  for (const line of lines) {
    const edges = findBoxEdgePositions(line)
    lineEdges.push(edges)
    lineEdgePositions.push(edges.map((e) => e.pos))
  }

  // Step 2: Cluster positions into alignment groups (same-line aware)
  const positionMapping = clusterPositions(lineEdgePositions)

  // Step 3: For each line, check if any edge needs adjustment
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const edges = lineEdges[i]

    // Check if this line needs any adjustments
    let needsFix = false
    for (const e of edges) {
      const target = positionMapping.get(e.pos)
      if (target !== undefined && target !== e.pos) {
        needsFix = true
        break
      }
    }

    if (!needsFix) {
      result.push(lines[i])
      continue
    }

    // Build the target mapping for this line's edges
    const edgeMapping: [number, number][] = edges.map((e) => [
      e.pos,
      positionMapping.get(e.pos) ?? e.pos,
    ])

    result.push(rebuildBoxLine(lines[i], edgeMapping))
  }

  return result
}

/**
 * Rebuild a box line so that each right-edge box char lands at its target
 * display-width column.
 *
 * Uses a segment-based approach: split the line at each right-edge box char,
 * then for each edge, adjust the preceding segment's width so the edge lands
 * on the target column.
 */
function rebuildBoxLine(line: string, edgeMapping: [number, number][]): string {
  // Split line into segments: alternating content and edge chars
  const segments: { text: string; isEdge: boolean; edgeChar: string }[] = []
  let current = ''

  for (const ch of line) {
    if (ALL_RIGHT_EDGE.has(ch)) {
      segments.push({ text: current, isEdge: false, edgeChar: '' })
      segments.push({ text: ch, isEdge: true, edgeChar: ch })
      current = ''
    } else {
      current += ch
    }
  }
  if (current) segments.push({ text: current, isEdge: false, edgeChar: '' })

  // Build mapping from current position → target position
  const edgeMap = new Map<number, number>()
  for (const [cur, target] of edgeMapping) {
    edgeMap.set(cur, target)
  }

  // Rebuild: walk through segments, tracking display width
  let rebuilt = ''
  let currentWidth = 0
  let edgeIdx = 0

  for (const seg of segments) {
    if (seg.isEdge) {
      // Look up the target for this edge based on its current position
      const currentPos = currentWidth

      // Find the matching edge in our mapping
      // We need to match by sequence order since positions may have shifted
      const [origPos, targetPos] = edgeMapping[edgeIdx] ?? [currentPos, currentPos]
      const delta = targetPos - currentPos

      if (delta !== 0) {
        // Adaptive tolerance
        const multiByteCount = countMultiByteChars(line)
        const maxDelta = multiByteCount >= 10 ? 5 : multiByteCount >= 3 ? 3 : 2

        if (Math.abs(delta) <= maxDelta) {
          rebuilt = adjustSegmentBeforeEdge(rebuilt, delta)
        }
      }

      rebuilt += seg.edgeChar
      currentWidth = displayWidth(rebuilt)
      edgeIdx++
    } else {
      rebuilt += seg.text
      currentWidth += displayWidth(seg.text)
    }
  }

  return rebuilt
}

/**
 * Adjust the content just before a box edge to shift it by `delta` display columns.
 * Positive delta = need more width (insert spaces/dashes).
 * Negative delta = need less width (remove spaces/dashes).
 */
function adjustSegmentBeforeEdge(content: string, delta: number): string {
  if (delta === 0) return content

  if (delta > 0) {
    // Need to add width — check what the content ends with
    const dashMatch = content.match(/([─━═]+)$/)
    if (dashMatch) {
      return content + dashMatch[1][0].repeat(delta)
    }
    return content + ' '.repeat(delta)
  } else {
    // Need to remove width
    const removeCount = Math.abs(delta)

    // Try removing trailing spaces first
    const spaceMatch = content.match(/( +)$/)
    if (spaceMatch && spaceMatch[1].length >= removeCount) {
      return content.slice(0, content.length - removeCount)
    }

    // Try removing trailing dashes
    const dashMatch = content.match(/([─━═]+)$/)
    if (dashMatch && dashMatch[1].length >= removeCount) {
      return content.slice(0, content.length - removeCount)
    }

    // Remove whatever trailing spaces we can
    let trimmed = content
    let removed = 0
    while (removed < removeCount && trimmed.endsWith(' ')) {
      trimmed = trimmed.slice(0, -1)
      removed++
    }
    // If we still need to remove more, try dashes
    while (removed < removeCount) {
      const lastChar = [...trimmed].at(-1)
      if (lastChar && '─━═'.includes(lastChar)) {
        trimmed = [...trimmed].slice(0, -1).join('')
        removed++
      } else {
        break
      }
    }
    return trimmed
  }
}

/**
 * Determine what character to insert before a box edge.
 * If the preceding content is dashes, insert a dash.
 * Otherwise insert a space.
 */
function findInsertChar(chars: { ch: string; w: number }[], edgeIdx: number): string {
  for (let j = edgeIdx - 1; j >= 0 && j >= edgeIdx - 3; j--) {
    if ('─━═'.includes(chars[j].ch)) return chars[j].ch
  }
  return ' '
}

/** Count characters that occupy >1 byte in UTF-8. */
function countMultiByteChars(str: string): number {
  let count = 0
  for (const ch of str) {
    if (ch.codePointAt(0)! > 0x7f) count++
  }
  return count
}

function mostCommonChar(s: string, candidates: string): string {
  const counts = new Map<string, number>()
  for (const ch of s) {
    if (candidates.includes(ch)) {
      counts.set(ch, (counts.get(ch) || 0) + 1)
    }
  }
  let best = candidates[0]
  let bestCount = 0
  for (const [ch, count] of counts) {
    if (count > bestCount) {
      best = ch
      bestCount = count
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Flow diagram alignment (pipe columns)
// ---------------------------------------------------------------------------

function findPipeColumns(line: string): number[] {
  const cols: number[] = []
  let width = 0
  for (const char of line) {
    if (char === '|') cols.push(width)
    width += charDisplayWidth(char.codePointAt(0)!)
  }
  return cols
}

function findAnchorLine(lines: string[]): number {
  // Prefer pipe-only lines
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0 && /^[\s|]+$/.test(lines[i])) {
      return i
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i].match(/\|/g) || []).length >= 2) {
      return i
    }
  }
  return -1
}

function fixFlowAlignment(lines: string[]): string[] {
  const anchorIdx = findAnchorLine(lines)
  if (anchorIdx === -1) return lines

  const anchorCols = findPipeColumns(lines[anchorIdx])
  if (anchorCols.length < 2) return lines

  return lines.map((line, i) => {
    if (i === anchorIdx) return line
    const cols = findPipeColumns(line)
    if (cols.length === 0) return line
    return fixLineFlowAlignment(line, cols, anchorCols)
  })
}

function fixLineFlowAlignment(line: string, currentCols: number[], anchorCols: number[]): string {
  const mapping = mapPipesToAnchors(currentCols, anchorCols)
  if (mapping.every(([cur, target]) => cur === target)) return line
  return rebuildFlowLine(line, mapping)
}

function mapPipesToAnchors(currentCols: number[], anchorCols: number[]): [number, number][] {
  return currentCols.map((cur) => {
    let bestAnchor = cur
    let bestDist = Infinity
    for (const anchor of anchorCols) {
      const dist = Math.abs(cur - anchor)
      if (dist <= 2 && dist < bestDist) {
        bestDist = dist
        bestAnchor = anchor
      }
    }
    return [cur, bestAnchor]
  })
}

function rebuildFlowLine(line: string, mapping: [number, number][]): string {
  const segments: { text: string; isPipe: boolean }[] = []
  let current = ''

  for (const char of line) {
    if (char === '|') {
      segments.push({ text: current, isPipe: false })
      segments.push({ text: '|', isPipe: true })
      current = ''
    } else {
      current += char
    }
  }
  if (current) segments.push({ text: current, isPipe: false })

  let pipeIdx = 0
  let rebuilt = ''
  let currentWidth = 0

  for (const seg of segments) {
    if (seg.isPipe) {
      const [, targetCol] = mapping[pipeIdx] ?? [currentWidth, currentWidth]
      const delta = targetCol - currentWidth
      if (delta !== 0) {
        rebuilt = adjustFlowSegmentWidth(rebuilt, delta)
      }
      rebuilt += '|'
      currentWidth = targetCol + 1
      pipeIdx++
    } else {
      rebuilt += seg.text
      currentWidth += displayWidth(seg.text)
    }
  }

  return rebuilt
}

function adjustFlowSegmentWidth(segment: string, delta: number): string {
  if (delta === 0) return segment

  const dashMatch = segment.match(/([\s]*[─\-=═►>]+[\s]*)$/)
  if (dashMatch) {
    const dashPart = dashMatch[0]
    const prefix = segment.slice(0, segment.length - dashPart.length)
    const dashChar = mostCommonChar(dashPart, '─-=═')

    if (delta > 0) {
      const trailingMatch = dashPart.match(/([>►\s]+)$/)
      if (trailingMatch) {
        const insertPos = dashPart.length - trailingMatch[0].length
        return (
          prefix + dashPart.slice(0, insertPos) + dashChar.repeat(delta) + dashPart.slice(insertPos)
        )
      }
      return prefix + dashPart + dashChar.repeat(delta)
    } else {
      return prefix + removeFromDashRun(dashPart, Math.abs(delta))
    }
  }

  const spaceMatch = segment.match(/( +)$/)
  if (spaceMatch) {
    const spaces = spaceMatch[1]
    const prefix = segment.slice(0, segment.length - spaces.length)
    return prefix + ' '.repeat(Math.max(0, spaces.length + delta))
  }

  if (delta > 0) return segment + ' '.repeat(delta)
  return segment
}

function removeFromDashRun(segment: string, count: number): string {
  let remaining = count
  const chars = [...segment]

  const trailing: string[] = []
  let i = chars.length - 1
  while (i >= 0 && !'─-=═ '.includes(chars[i])) {
    trailing.unshift(chars[i])
    i--
  }

  const middle: string[] = []
  while (i >= 0) {
    if (remaining > 0 && '─-=═ '.includes(chars[i])) {
      remaining--
    } else {
      middle.unshift(chars[i])
    }
    i--
  }

  return middle.join('') + trailing.join('')
}

// ---------------------------------------------------------------------------
// Code block extraction & processing
// ---------------------------------------------------------------------------

interface CodeBlock {
  startLine: number
  endLine: number
  lang: string
  contentLines: string[]
}

function extractCodeBlocks(lines: string[]): CodeBlock[] {
  const blocks: CodeBlock[] = []
  let inBlock = false
  let currentBlock: Partial<CodeBlock> | null = null

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()

    if (!inBlock) {
      const openMatch = trimmed.match(/^```(\w*)\s*$/)
      if (openMatch) {
        const lang = openMatch[1].toLowerCase()
        if (lang === '' || lang === 'text') {
          inBlock = true
          currentBlock = { startLine: i, lang, contentLines: [] }
        }
      }
    } else {
      if (trimmed.match(/^```\s*$/)) {
        inBlock = false
        blocks.push({ ...currentBlock, endLine: i } as CodeBlock)
        currentBlock = null
      } else {
        currentBlock!.contentLines!.push(lines[i])
      }
    }
  }

  return blocks
}

function fixDiagramBlock(contentLines: string[]): { lines: string[]; isDiagram: boolean } {
  if (looksLikeBoxDiagram(contentLines)) {
    return { lines: fixBoxAlignment(contentLines), isDiagram: true }
  }
  if (looksLikeFlowDiagram(contentLines)) {
    return { lines: fixFlowAlignment(contentLines), isDiagram: true }
  }
  return { lines: contentLines, isDiagram: false }
}

function processContent(content: string): string | null {
  const lines = content.split('\n')
  const blocks = extractCodeBlocks(lines)
  let changed = false

  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b]
    const { lines: fixed, isDiagram } = fixDiagramBlock(block.contentLines)

    let blockChanged = false
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i] !== block.contentLines[i]) {
        blockChanged = true
        break
      }
    }

    // Add `text` language to bare ``` fences on diagram blocks
    if (isDiagram && block.lang === '') {
      const fenceLine = lines[block.startLine]
      lines[block.startLine] = fenceLine.replace(/^(\s*```)(\s*)$/, '$1text$2')
      changed = true
    }

    if (blockChanged) {
      changed = true
      lines.splice(block.startLine + 1, block.contentLines.length, ...fixed)
    }
  }

  return changed ? lines.join('\n') : null
}

// ---------------------------------------------------------------------------
// File system
// ---------------------------------------------------------------------------

async function collectMarkdownFiles(dirPath: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(fullPath)
        }
      } else if (extname(entry.name).toLowerCase() === '.md') {
        files.push(fullPath)
      }
    }
  }
  await walk(dirPath)
  return files
}

async function processFile(filePath: string): Promise<boolean> {
  const content = await readFile(filePath, 'utf-8')
  const fixed = processContent(content)
  if (fixed !== null) {
    await writeFile(filePath, fixed, 'utf-8')
    console.log(`✅ Fixed: ${filePath}`)
    return true
  } else {
    console.log(`── No changes: ${filePath}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const target = process.argv[2]

  if (!target) {
    console.error('Usage: bun run fix-flow-align.ts <file-or-directory>')
    process.exit(1)
  }

  const info = await stat(target).catch(() => null)
  if (!info) {
    console.error(`Error: "${target}" not found`)
    process.exit(1)
  }

  let filesFixed = 0
  let filesProcessed = 0

  if (info.isDirectory()) {
    const files = await collectMarkdownFiles(target)
    if (files.length === 0) {
      console.log('No markdown files found.')
      return
    }
    console.log(`Found ${files.length} markdown file(s)\n`)
    for (const file of files) {
      filesProcessed++
      if (await processFile(file)) filesFixed++
    }
  } else {
    filesProcessed = 1
    if (await processFile(target)) filesFixed++
  }

  console.log(`\nDone: ${filesFixed}/${filesProcessed} file(s) modified.`)
}

main()
