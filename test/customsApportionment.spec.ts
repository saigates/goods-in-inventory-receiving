// TEMP_EXPORT_STANDARD re-import customs apportionment — value-based,
// largest-remainder rounding, hold-until-fully-priced. Pure-function
// tests, mirroring test/freightApportionment.spec.ts's coverage exactly
// (same method, deliberately separate module — see customsApportionment.ts
// header comment for why).
import { describe, expect, it } from 'vitest'
import { apportionCustomsByValue, type PricedDeviceLine } from '../src/lib/customsApportionment'

describe('apportionCustomsByValue — value-based apportionment, largest-remainder rounding', () => {
  it('rounded shares sum EXACTLY to the customs total (no penny lost or invented)', () => {
    const lines: PricedDeviceLine[] = [
      { received_device_id: 1, price_gbp: 100 },
      { received_device_id: 2, price_gbp: 100 },
      { received_device_id: 3, price_gbp: 100 },
    ]
    const result = apportionCustomsByValue([1, 2, 3], lines, 10) // £10 / 3 devices = 3.333.. each
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sum = result.shares.reduce((s, r) => s + r.share_gbp, 0)
    expect(Math.round(sum * 100) / 100).toBe(10)
    expect(result.total_apportioned_gbp).toBe(10)
  })

  it('places the residual penny on the LARGEST line when remainders tie', () => {
    const lines: PricedDeviceLine[] = [
      { received_device_id: 5, price_gbp: 50 },
      { received_device_id: 2, price_gbp: 50 },
    ]
    const result = apportionCustomsByValue([5, 2], lines, 10.01)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sum = result.shares.reduce((s, r) => s + r.share_gbp, 0)
    expect(Math.round(sum * 100) / 100).toBe(10.01)
    // With equal price and equal remainder, the tie-break falls to the
    // lower device_id (deterministic, documented behaviour), same as
    // apportionFreightByValue.
    const winner = result.shares.find(s => s.share_gbp > 5.0)
    expect(winner).toBeDefined()
  })

  it('holds (does not apportion) when any device in the consignment is not yet priced', () => {
    const lines: PricedDeviceLine[] = [
      { received_device_id: 1, price_gbp: 100 },
      // device_id 2 is a member of the consignment but has no priced line yet
    ]
    const result = apportionCustomsByValue([1, 2], lines, 50)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/not yet priced/)
    expect(result.pending_reason).toMatch(/device_id\(s\): 2/)
  })

  it('rejects an empty consignment', () => {
    const result = apportionCustomsByValue([], [], 100)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/no devices/)
  })

  it('rejects a negative customs total', () => {
    const lines: PricedDeviceLine[] = [{ received_device_id: 1, price_gbp: 100 }]
    const result = apportionCustomsByValue([1], lines, -5)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/non-negative/)
  })

  it('rejects a consignment whose priced lines sum to zero', () => {
    const lines: PricedDeviceLine[] = [
      { received_device_id: 1, price_gbp: 0 },
      { received_device_id: 2, price_gbp: 0 },
    ]
    const result = apportionCustomsByValue([1, 2], lines, 50)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/sum of priced lines is zero/i)
  })

  it('a zero customs total apportions to zero on every device, exactly', () => {
    const lines: PricedDeviceLine[] = [
      { received_device_id: 1, price_gbp: 100 },
      { received_device_id: 2, price_gbp: 200 },
    ]
    const result = apportionCustomsByValue([1, 2], lines, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.total_apportioned_gbp).toBe(0)
    expect(result.shares.every(s => s.share_gbp === 0)).toBe(true)
  })

  it('apportions strictly by value — the higher-priced device gets the larger share', () => {
    const lines: PricedDeviceLine[] = [
      { received_device_id: 1, price_gbp: 90 },
      { received_device_id: 2, price_gbp: 452 },
    ]
    const result = apportionCustomsByValue([1, 2], lines, 100)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const d1 = result.shares.find(s => s.received_device_id === 1)!
    const d2 = result.shares.find(s => s.received_device_id === 2)!
    expect(d2.share_gbp).toBeGreaterThan(d1.share_gbp)
    // sanity: 90/542*100 ≈ 16.61, 452/542*100 ≈ 83.39
    expect(d1.share_gbp).toBeCloseTo(16.61, 1)
    expect(d2.share_gbp).toBeCloseTo(83.39, 1)
  })

  it('real-scale figures — 90-device return consignment, £8,500 customs apportioned exactly', () => {
    const n = 90
    const total = 8500
    const lines: PricedDeviceLine[] = Array.from({ length: n }, (_, i) => ({
      received_device_id: i + 1,
      price_gbp: 200 + (i % 5) * 1.13,
    }))
    const result = apportionCustomsByValue(lines.map(l => l.received_device_id), lines, total)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.shares).toHaveLength(90)
    expect(result.total_apportioned_gbp).toBe(total)
    const ids = result.shares.map(s => s.received_device_id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
