import { describe, it, expect, beforeEach } from 'vitest'
import { parseScheduleTime, setWarnFn } from '../../../build/lib/parse-schedule-time.mjs'

// Suppress warnings during tests (overridden in 'warns on issues' describe)
beforeEach(() => {
  setWarnFn(() => {})
})

describe('parseScheduleTime', () => {
  // ── 12-hour format ──────────────────────────────────────────────────

  describe('12-hour format', () => {
    it('parses AM time', () => {
      const result = parseScheduleTime('9:30 AM PST', 'test')
      expect(result.cronExpr).toBe('30 9 * * *')
      expect(result.ianaTz).toBe('America/Los_Angeles')
    })

    it('parses PM time', () => {
      const result = parseScheduleTime('3:00 PM EST', 'test')
      expect(result.cronExpr).toBe('0 15 * * *')
      expect(result.ianaTz).toBe('America/New_York')
    })

    it('handles 12 PM (noon) → hour 12', () => {
      const result = parseScheduleTime('12:00 PM UTC', 'test')
      expect(result.cronExpr).toBe('0 12 * * *')
    })

    it('handles 12 AM (midnight) → hour 0', () => {
      const result = parseScheduleTime('12:00 AM UTC', 'test')
      expect(result.cronExpr).toBe('0 0 * * *')
    })

    it('handles 1 AM → hour 1', () => {
      const result = parseScheduleTime('1:00 AM UTC', 'test')
      expect(result.cronExpr).toBe('0 1 * * *')
    })

    it('handles 1 PM → hour 13', () => {
      const result = parseScheduleTime('1:00 PM UTC', 'test')
      expect(result.cronExpr).toBe('0 13 * * *')
    })

    it('handles 11 PM → hour 23', () => {
      const result = parseScheduleTime('11:59 PM UTC', 'test')
      expect(result.cronExpr).toBe('59 23 * * *')
    })

    it('handles single-digit hour', () => {
      const result = parseScheduleTime('3:00 AM PST', 'test')
      expect(result.cronExpr).toBe('0 3 * * *')
    })

    it('is case-insensitive for AM/PM', () => {
      expect(parseScheduleTime('3:00 am PST', 'test').cronExpr).toBe('0 3 * * *')
      expect(parseScheduleTime('3:00 Am PST', 'test').cronExpr).toBe('0 3 * * *')
      expect(parseScheduleTime('3:00 PM PST', 'test').cronExpr).toBe('0 15 * * *')
      expect(parseScheduleTime('3:00 pm PST', 'test').cronExpr).toBe('0 15 * * *')
    })
  })

  // ── 24-hour format ──────────────────────────────────────────────────

  describe('24-hour format', () => {
    it('parses morning time with timezone', () => {
      const result = parseScheduleTime('9:30 UTC', 'test')
      expect(result.cronExpr).toBe('30 9 * * *')
      expect(result.ianaTz).toBe('UTC')
    })

    it('parses afternoon time with timezone', () => {
      const result = parseScheduleTime('16:30 UTC', 'test')
      expect(result.cronExpr).toBe('30 16 * * *')
      expect(result.ianaTz).toBe('UTC')
    })

    it('parses midnight (0:00)', () => {
      const result = parseScheduleTime('0:00 PST', 'test')
      expect(result.cronExpr).toBe('0 0 * * *')
      expect(result.ianaTz).toBe('America/Los_Angeles')
    })

    it('parses 23:59', () => {
      const result = parseScheduleTime('23:59 JST', 'test')
      expect(result.cronExpr).toBe('59 23 * * *')
      expect(result.ianaTz).toBe('Asia/Tokyo')
    })

    it('parses morning time without timezone', () => {
      const result = parseScheduleTime('8:00', 'test')
      expect(result.cronExpr).toBe('0 8 * * *')
      expect(result.ianaTz).toBe('')
    })

    it('parses afternoon time without timezone', () => {
      const result = parseScheduleTime('16:30', 'test')
      expect(result.cronExpr).toBe('30 16 * * *')
      expect(result.ianaTz).toBe('')
    })

    it('parses with IANA timezone', () => {
      const result = parseScheduleTime('14:00 Asia/Tokyo', 'test')
      expect(result.cronExpr).toBe('0 14 * * *')
      expect(result.ianaTz).toBe('Asia/Tokyo')
    })

    it('throws on hour > 23', () => {
      expect(() => parseScheduleTime('25:00 UTC', 'test')).toThrow('Invalid hour')
    })

    it('throws on minute > 59', () => {
      expect(() => parseScheduleTime('12:60 UTC', 'test')).toThrow('Invalid minute')
    })
  })

  // ── Timezone omitted ───────────────────────────────────────────────

  describe('timezone omitted (falls back to VPS host timezone)', () => {
    it('12-hour AM without timezone', () => {
      const result = parseScheduleTime('9:30 AM', 'test')
      expect(result.cronExpr).toBe('30 9 * * *')
      expect(result.ianaTz).toBe('')
    })

    it('12-hour PM without timezone', () => {
      const result = parseScheduleTime('3:15 PM', 'test')
      expect(result.cronExpr).toBe('15 15 * * *')
      expect(result.ianaTz).toBe('')
    })

    it('24-hour morning without timezone', () => {
      const result = parseScheduleTime('6:00', 'test')
      expect(result.cronExpr).toBe('0 6 * * *')
      expect(result.ianaTz).toBe('')
    })

    it('24-hour afternoon without timezone', () => {
      const result = parseScheduleTime('18:45', 'test')
      expect(result.cronExpr).toBe('45 18 * * *')
      expect(result.ianaTz).toBe('')
    })

    it('midnight without timezone', () => {
      const result = parseScheduleTime('12:00 AM', 'test')
      expect(result.cronExpr).toBe('0 0 * * *')
      expect(result.ianaTz).toBe('')
    })

    it('noon without timezone', () => {
      const result = parseScheduleTime('12:00 PM', 'test')
      expect(result.cronExpr).toBe('0 12 * * *')
      expect(result.ianaTz).toBe('')
    })
  })

  // ── Timezone resolution ─────────────────────────────────────────────

  describe('timezone resolution', () => {
    it('resolves abbreviation to IANA', () => {
      expect(parseScheduleTime('9:00 AM JST', 'test').ianaTz).toBe('Asia/Tokyo')
      expect(parseScheduleTime('9:00 AM KST', 'test').ianaTz).toBe('Asia/Seoul')
      expect(parseScheduleTime('9:00 AM IST', 'test').ianaTz).toBe('Asia/Kolkata')
    })

    it('accepts full IANA name directly', () => {
      expect(parseScheduleTime('9:00 AM Asia/Tokyo', 'test').ianaTz).toBe('Asia/Tokyo')
    })

    it('accepts IANA name with multiple segments', () => {
      expect(parseScheduleTime('9:00 AM America/Indiana/Indianapolis', 'test').ianaTz).toBe('America/Indiana/Indianapolis')
    })

    it('returns empty ianaTz for unknown abbreviation', () => {
      const result = parseScheduleTime('9:00 AM FAKE', 'test')
      expect(result.cronExpr).toBe('0 9 * * *')
      expect(result.ianaTz).toBe('')
    })

    it('is case-insensitive for abbreviations', () => {
      expect(parseScheduleTime('9:00 AM pst', 'test').ianaTz).toBe('America/Los_Angeles')
      expect(parseScheduleTime('9:00 AM Pst', 'test').ianaTz).toBe('America/Los_Angeles')
      expect(parseScheduleTime('9:00 AM PST', 'test').ianaTz).toBe('America/Los_Angeles')
    })

    it('preserves case for IANA names', () => {
      expect(parseScheduleTime('9:00 AM America/Los_Angeles', 'test').ianaTz).toBe('America/Los_Angeles')
    })

    it('works with 24-hour format abbreviations', () => {
      expect(parseScheduleTime('14:00 CET', 'test').ianaTz).toBe('Europe/Berlin')
      expect(parseScheduleTime('3:00 AEST', 'test').ianaTz).toBe('Australia/Sydney')
    })

    it('works with 24-hour format IANA names', () => {
      expect(parseScheduleTime('14:00 Europe/Berlin', 'test').ianaTz).toBe('Europe/Berlin')
    })

    it('DST abbreviation pairs resolve to the same IANA zone', () => {
      const pst = parseScheduleTime('9:00 AM PST', 'test')
      const pdt = parseScheduleTime('9:00 AM PDT', 'test')
      expect(pst.ianaTz).toBe(pdt.ianaTz)
      expect(pst.cronExpr).toBe(pdt.cronExpr)
    })
  })

  // ── Empty input (non-fatal) ─────────────────────────────────────────

  describe('empty input (returns empty, does not throw)', () => {
    it('returns empty for null', () => {
      const result = parseScheduleTime(null, 'test')
      expect(result.cronExpr).toBe('')
      expect(result.ianaTz).toBe('')
    })

    it('returns empty for undefined', () => {
      const result = parseScheduleTime(undefined, 'test')
      expect(result.cronExpr).toBe('')
      expect(result.ianaTz).toBe('')
    })

    it('returns empty for empty string', () => {
      const result = parseScheduleTime('', 'test')
      expect(result.cronExpr).toBe('')
      expect(result.ianaTz).toBe('')
    })
  })

  // ── Invalid input (throws) ────────────────────────────────────────

  describe('invalid input (throws to fail the build)', () => {
    it('throws on unparseable text', () => {
      expect(() => parseScheduleTime('not a time', 'test')).toThrow('Could not parse')
    })

    it('throws on numeric input', () => {
      expect(() => parseScheduleTime(12345, 'test')).toThrow('Could not parse')
    })

    it('throws on just a timezone', () => {
      expect(() => parseScheduleTime('PST', 'test')).toThrow('Could not parse')
    })

    it('throws on hour > 23 in 24-hour format', () => {
      expect(() => parseScheduleTime('25:00 UTC', 'test')).toThrow('Invalid hour')
    })

    it('throws on minute > 59 in 24-hour format', () => {
      expect(() => parseScheduleTime('12:60 UTC', 'test')).toThrow('Invalid minute')
    })

    it('throws on hour > 12 in 12-hour format', () => {
      expect(() => parseScheduleTime('13:00 AM UTC', 'test')).toThrow('Invalid hour')
    })

    it('throws on hour 0 in 12-hour format', () => {
      expect(() => parseScheduleTime('0:00 AM UTC', 'test')).toThrow('Invalid hour')
    })

    it('throws on minute > 59 in 12-hour format', () => {
      expect(() => parseScheduleTime('9:60 AM UTC', 'test')).toThrow('Invalid minute')
    })

    it('includes the label in error messages', () => {
      expect(() => parseScheduleTime('garbage', 'daily_report')).toThrow('daily_report')
    })

    it('includes the input value in error messages', () => {
      expect(() => parseScheduleTime('garbage', 'test')).toThrow('garbage')
    })
  })

  // ── Warnings (non-fatal) ──────────────────────────────────────────

  describe('warnings (non-fatal)', () => {
    it('warns on unknown timezone abbreviation but still parses time', () => {
      let warning = ''
      setWarnFn((msg) => { warning = msg })
      const result = parseScheduleTime('9:00 AM FAKE', 'daily_report')
      expect(result.cronExpr).toBe('0 9 * * *')
      expect(result.ianaTz).toBe('')
      expect(warning).toContain('Unknown timezone')
      expect(warning).toContain('FAKE')
      expect(warning).toContain('daily_report')
    })

    it('does not warn on valid 12-hour input', () => {
      let warning = ''
      setWarnFn((msg) => { warning = msg })
      parseScheduleTime('9:30 AM PST', 'test')
      expect(warning).toBe('')
    })

    it('does not warn on valid 24-hour input', () => {
      let warning = ''
      setWarnFn((msg) => { warning = msg })
      parseScheduleTime('16:30 UTC', 'test')
      expect(warning).toBe('')
    })

    it('does not warn when timezone is omitted', () => {
      let warning = ''
      setWarnFn((msg) => { warning = msg })
      parseScheduleTime('9:30 AM', 'test')
      expect(warning).toBe('')
    })
  })
})
