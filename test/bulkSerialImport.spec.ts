// Step 2A gap (a) — pure-function tests for bulkSerialImport.ts
// (parseBulkSerialInput / classifyBulkSerials). No D1, no HTTP — mirrors
// the pure-function test convention in test/zohoSaleImport.spec.ts /
// test/skuMapImport.spec.ts's parse-layer describe blocks.
import { describe, expect, it } from 'vitest'
import {
  classifyBulkSerials,
  normaliseBulkSerial,
  parseBulkSerialInput,
  type BulkSerialDeviceLookup,
} from '../src/lib/bulkSerialImport'

describe('parseBulkSerialInput — bare list (no column mapping)', () => {
  it('treats every non-blank line as a serial, verbatim (trimmed)', () => {
    const result = parseBulkSerialInput('351264783478842\n  354208278831830  \n\n359551270317364\n')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.serials).toEqual(['351264783478842', '354208278831830', '359551270317364'])
  })

  it('handles CRLF line endings the same as LF', () => {
    const result = parseBulkSerialInput('AAA\r\nBBB\r\nCCC')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.serials).toEqual(['AAA', 'BBB', 'CCC'])
  })

  it('empty input is refused, not silently treated as zero serials', () => {
    const result = parseBulkSerialInput('   \n\n  ')
    expect(result.ok).toBe(false)
  })
})

describe('parseBulkSerialInput — column-mapped CSV (supplier layout varies)', () => {
  it('extracts the named column from a header + data rows', () => {
    const csv = 'Supplier Ref,Serial Number,Notes\nREF-1,351264783478842,ok\nREF-2,354208278831830,ok'
    const result = parseBulkSerialInput(csv, 'Serial Number')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.serials).toEqual(['351264783478842', '354208278831830'])
  })

  it('an unknown column name is refused with the real header list', () => {
    const csv = 'Ref,Code\nA,1'
    const result = parseBulkSerialInput(csv, 'Serial Number')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Ref, Code')
  })

  it('a fully blank line in the file is dropped entirely (carries no data in any column)', () => {
    const csv = 'Serial\n351264783478842\n\nAAA'
    const result = parseBulkSerialInput(csv, 'Serial')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.serials).toEqual(['351264783478842', 'AAA'])
  })

  it('a blank CELL in the serial column (row present, column empty) becomes an empty-string serial — classification handles it as unknown', () => {
    const csv = 'Serial,Notes\n351264783478842,ok\n,blank-serial-but-row-exists\nAAA,ok'
    const result = parseBulkSerialInput(csv, 'Serial')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.serials).toEqual(['351264783478842', '', 'AAA'])
  })
})

describe('normaliseBulkSerial — case-insensitive, whitespace-insensitive', () => {
  it('uppercases and trims', () => {
    expect(normaliseBulkSerial('  rfat12vx6ey  ')).toBe('RFAT12VX6EY')
    expect(normaliseBulkSerial('351264783478842')).toBe('351264783478842')
  })
})

describe('classifyBulkSerials — every serial gets exactly one explicit outcome, never a silent default', () => {
  function lookup(entries: Array<[string, BulkSerialDeviceLookup]>): Map<string, BulkSerialDeviceLookup> {
    return new Map(entries)
  }

  it('a serial with no matching device classifies as unknown', () => {
    const outcomes = classifyBulkSerials(['NO-MATCH'], lookup([]), 'READY_FOR_EXPORT', new Set())
    expect(outcomes).toEqual([{ serial: 'NO-MATCH', normalised: 'NO-MATCH', outcome: 'unknown' }])
  })

  it('a blank/whitespace-only serial classifies as unknown, never crashes or is silently skipped', () => {
    const outcomes = classifyBulkSerials(['   '], lookup([]), 'READY_FOR_EXPORT', new Set())
    expect(outcomes).toEqual([{ serial: '   ', normalised: '', outcome: 'unknown' }])
  })

  it('a device at the expected status classifies as matched', () => {
    const devices = lookup([['AAA', { id: 1, status: 'READY_FOR_EXPORT' }]])
    const outcomes = classifyBulkSerials(['aaa'], devices, 'READY_FOR_EXPORT', new Set())
    expect(outcomes).toEqual([{ serial: 'aaa', normalised: 'AAA', outcome: 'matched', deviceId: 1 }])
  })

  it('case-insensitive match: lowercase input matches an uppercase-keyed device map entry', () => {
    const devices = lookup([['RFAT12VX6EY', { id: 5, status: 'READY_FOR_EXPORT' }]])
    const outcomes = classifyBulkSerials(['rfat12vx6ey'], devices, 'READY_FOR_EXPORT', new Set())
    expect(outcomes[0]).toMatchObject({ outcome: 'matched', deviceId: 5 })
  })

  it('a SOLD device classifies as already_sold, distinct from a generic already_out', () => {
    const devices = lookup([['AAA', { id: 1, status: 'SOLD' }]])
    const outcomes = classifyBulkSerials(['AAA'], devices, 'READY_FOR_EXPORT', new Set())
    expect(outcomes).toEqual([{ serial: 'AAA', normalised: 'AAA', outcome: 'already_sold', deviceId: 1 }])
  })

  it('a device at a different, non-SOLD status classifies as already_out with the real status attached', () => {
    const devices = lookup([['AAA', { id: 1, status: 'IN_EXPORT_CONSIGNMENT' }]])
    const outcomes = classifyBulkSerials(['AAA'], devices, 'READY_FOR_EXPORT', new Set())
    expect(outcomes).toEqual([{ serial: 'AAA', normalised: 'AAA', outcome: 'already_out', deviceId: 1, status: 'IN_EXPORT_CONSIGNMENT' }])
  })

  it('a device already on THIS shipment classifies as already_on_this_shipment, not already_out (idempotent resubmission)', () => {
    const devices = lookup([['AAA', { id: 1, status: 'IN_EXPORT_CONSIGNMENT' }]])
    const outcomes = classifyBulkSerials(['AAA'], devices, 'READY_FOR_EXPORT', new Set([1]))
    expect(outcomes).toEqual([{ serial: 'AAA', normalised: 'AAA', outcome: 'already_on_this_shipment', deviceId: 1 }])
  })

  it('a duplicate serial within one submission is reported as duplicate_in_submission, never double-processed', () => {
    const devices = lookup([['AAA', { id: 1, status: 'READY_FOR_EXPORT' }]])
    const outcomes = classifyBulkSerials(['AAA', 'AAA', 'aaa'], devices, 'READY_FOR_EXPORT', new Set())
    expect(outcomes).toEqual([
      { serial: 'AAA', normalised: 'AAA', outcome: 'matched', deviceId: 1 },
      { serial: 'AAA', normalised: 'AAA', outcome: 'duplicate_in_submission' },
      { serial: 'aaa', normalised: 'AAA', outcome: 'duplicate_in_submission' },
    ])
  })

  it('a mixed batch: every serial gets a distinct explicit outcome, nothing silently defaults', () => {
    const devices = lookup([
      ['MATCH1', { id: 1, status: 'READY_FOR_EXPORT' }],
      ['SOLDONE', { id: 2, status: 'SOLD' }],
      ['OUTONE', { id: 3, status: 'IN_EXPORT_CONSIGNMENT' }],
    ])
    const outcomes = classifyBulkSerials(
      ['MATCH1', 'SOLDONE', 'OUTONE', 'UNKNOWN1', 'MATCH1'],
      devices, 'READY_FOR_EXPORT', new Set(),
    )
    expect(outcomes.map(o => o.outcome)).toEqual([
      'matched', 'already_sold', 'already_out', 'unknown', 'duplicate_in_submission',
    ])
  })
})
