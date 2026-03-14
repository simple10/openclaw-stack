import { describe, it, expect } from 'vitest'
import { TZ_ABBREVIATIONS } from '../../../build/lib/tz-abbreviations.mjs'

describe('TZ_ABBREVIATIONS', () => {
  it('maps US abbreviations to IANA names', () => {
    expect(TZ_ABBREVIATIONS.PST).toBe('America/Los_Angeles')
    expect(TZ_ABBREVIATIONS.PDT).toBe('America/Los_Angeles')
    expect(TZ_ABBREVIATIONS.EST).toBe('America/New_York')
    expect(TZ_ABBREVIATIONS.EDT).toBe('America/New_York')
    expect(TZ_ABBREVIATIONS.CST).toBe('America/Chicago')
    expect(TZ_ABBREVIATIONS.CDT).toBe('America/Chicago')
    expect(TZ_ABBREVIATIONS.MST).toBe('America/Denver')
    expect(TZ_ABBREVIATIONS.MDT).toBe('America/Denver')
    expect(TZ_ABBREVIATIONS.AKST).toBe('America/Anchorage')
    expect(TZ_ABBREVIATIONS.HST).toBe('Pacific/Honolulu')
  })

  it('maps European abbreviations', () => {
    expect(TZ_ABBREVIATIONS.GMT).toBe('Europe/London')
    expect(TZ_ABBREVIATIONS.BST).toBe('Europe/London')
    expect(TZ_ABBREVIATIONS.UTC).toBe('UTC')
    expect(TZ_ABBREVIATIONS.CET).toBe('Europe/Berlin')
    expect(TZ_ABBREVIATIONS.CEST).toBe('Europe/Berlin')
    expect(TZ_ABBREVIATIONS.EET).toBe('Europe/Bucharest')
    expect(TZ_ABBREVIATIONS.MSK).toBe('Europe/Moscow')
  })

  it('maps Asian abbreviations', () => {
    expect(TZ_ABBREVIATIONS.IST).toBe('Asia/Kolkata')
    expect(TZ_ABBREVIATIONS.JST).toBe('Asia/Tokyo')
    expect(TZ_ABBREVIATIONS.KST).toBe('Asia/Seoul')
    expect(TZ_ABBREVIATIONS.SGT).toBe('Asia/Singapore')
    expect(TZ_ABBREVIATIONS.HKT).toBe('Asia/Hong_Kong')
    expect(TZ_ABBREVIATIONS.PHT).toBe('Asia/Manila')
    expect(TZ_ABBREVIATIONS.ICT).toBe('Asia/Bangkok')
    expect(TZ_ABBREVIATIONS.PKT).toBe('Asia/Karachi')
    expect(TZ_ABBREVIATIONS.GST).toBe('Asia/Dubai')
  })

  it('maps Oceania abbreviations', () => {
    expect(TZ_ABBREVIATIONS.AEST).toBe('Australia/Sydney')
    expect(TZ_ABBREVIATIONS.AEDT).toBe('Australia/Sydney')
    expect(TZ_ABBREVIATIONS.AWST).toBe('Australia/Perth')
    expect(TZ_ABBREVIATIONS.NZST).toBe('Pacific/Auckland')
    expect(TZ_ABBREVIATIONS.NZDT).toBe('Pacific/Auckland')
  })

  it('maps African abbreviations', () => {
    expect(TZ_ABBREVIATIONS.WAT).toBe('Africa/Lagos')
    expect(TZ_ABBREVIATIONS.CAT).toBe('Africa/Harare')
    expect(TZ_ABBREVIATIONS.EAT).toBe('Africa/Nairobi')
    expect(TZ_ABBREVIATIONS.SAST).toBe('Africa/Johannesburg')
  })

  it('maps South American abbreviations', () => {
    expect(TZ_ABBREVIATIONS.BRT).toBe('America/Sao_Paulo')
    expect(TZ_ABBREVIATIONS.ART).toBe('America/Argentina/Buenos_Aires')
    expect(TZ_ABBREVIATIONS.CLT).toBe('America/Santiago')
    expect(TZ_ABBREVIATIONS.COT).toBe('America/Bogota')
  })

  it('all values are valid IANA timezone strings (contain / or are UTC)', () => {
    for (const [abbr, iana] of Object.entries(TZ_ABBREVIATIONS)) {
      expect(iana, `${abbr} → "${iana}" should contain / or be UTC`).toMatch(/\/|^UTC$/)
    }
  })

  it('all keys are uppercase', () => {
    for (const key of Object.keys(TZ_ABBREVIATIONS)) {
      expect(key, `key "${key}" should be uppercase`).toBe(key.toUpperCase())
    }
  })

  it('DST pairs map to the same IANA zone', () => {
    const pairs = [
      ['PST', 'PDT'],
      ['EST', 'EDT'],
      ['CST', 'CDT'],
      ['MST', 'MDT'],
      ['AKST', 'AKDT'],
      ['CET', 'CEST'],
      ['EET', 'EEST'],
      ['AEST', 'AEDT'],
      ['ACST', 'ACDT'],
      ['NZST', 'NZDT'],
      ['CLT', 'CLST'],
      ['BRT', 'BRST'],
      ['WET', 'WEST'],
      ['NST', 'NDT'],
      ['IRST', 'IRDT'],
    ]
    for (const [std, dst] of pairs) {
      expect(TZ_ABBREVIATIONS[std], `${std}/${dst} should map to same zone`).toBe(
        TZ_ABBREVIATIONS[dst]
      )
    }
  })
})
