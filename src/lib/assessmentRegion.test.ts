import { describe, expect, it } from 'vitest'
import { assessmentSignature, createEqualAreaRegion, DEFAULT_EQUAL_AREA_SIZE } from './assessmentRegion'
import { DEFAULT_ASSESSMENT_OPTIONS as options } from './assessmentTypes'

const source = { widthMm: 160, lengthMm: 60, minHeightMm: -.6, maxHeightMm: .4 }

describe('equal-area automatic assessment regions', () => {
  it('uses an exact centered 80×30 mm region and the full source height range', () => {
    const r = createEqualAreaRegion(source, DEFAULT_EQUAL_AREA_SIZE, 'x')
    expect(r.x).toEqual([40, 120]); expect(r.y).toEqual([15, 45])
    expect(r.z[0]).toBeLessThan(source.minHeightMm); expect(r.z[1]).toBeGreaterThan(source.maxHeightMm)
    expect((r.x[1] - r.x[0]) * (r.y[1] - r.y[0])).toBe(2400)
  })
  it('keeps identical nominal area for a differently sized screen, without searching height data', () => {
    const r = createEqualAreaRegion({ ...source, widthMm: 180, lengthMm: 80 }, DEFAULT_EQUAL_AREA_SIZE, 'x')
    expect(r.x).toEqual([50, 130]); expect(r.y).toEqual([25, 55])
    expect((r.x[1] - r.x[0]) * (r.y[1] - r.y[0])).toBe(2400)
  })
  it('rotates the rectangular dimensions with the explicitly selected hinge direction', () => {
    const r = createEqualAreaRegion({ ...source, widthMm: 60, lengthMm: 160 }, DEFAULT_EQUAL_AREA_SIZE, 'y')
    expect(r.x).toEqual([15, 45]); expect(r.y).toEqual([40, 120])
  })
  it('uses a manually specified hinge center without moving it to a convenient location', () => {
    expect(createEqualAreaRegion(source, DEFAULT_EQUAL_AREA_SIZE, 'x', 20).y).toEqual([5, 35])
    expect(createEqualAreaRegion({ ...source, widthMm: 60, lengthMm: 160 }, DEFAULT_EQUAL_AREA_SIZE, 'y', 35).x).toEqual([20, 50])
    expect(() => createEqualAreaRegion(source, DEFAULT_EQUAL_AREA_SIZE, 'x', 5)).toThrow('未偏移')
  })
  it('supports custom and exact-boundary sizes without mutating inputs', () => {
    const small = { ...source, widthMm: 80, lengthMm: 30 }
    const before = JSON.stringify(small)
    const r = createEqualAreaRegion(small, DEFAULT_EQUAL_AREA_SIZE, 'x')
    expect(r.x).toEqual([0, 80]); expect(r.y).toEqual([0, 30])
    expect(JSON.stringify(small)).toBe(before)
    const custom = createEqualAreaRegion(source, { alongMm: 40, acrossMm: 20 }, 'x')
    expect(custom.x).toEqual([60, 100]); expect(custom.y).toEqual([20, 40])
  })
  it('supports a perfectly flat source with a non-degenerate full Z interval', () => {
    const r = createEqualAreaRegion({ ...source, minHeightMm: .2, maxHeightMm: .2 }, DEFAULT_EQUAL_AREA_SIZE, 'x')
    expect(r.z[0]).toBeLessThan(.2); expect(r.z[1]).toBeGreaterThan(.2)
  })
  it.each([{ alongMm: 161, acrossMm: 30 }, { alongMm: 80, acrossMm: 61 }])('refuses insufficient scans instead of shrinking: %j', (size) => {
    expect(() => createEqualAreaRegion(source, size, 'x')).toThrow('未缩小')
  })
  it.each([0, -1, NaN, Infinity, 1001])('rejects invalid size %s', (value) => {
    expect(() => createEqualAreaRegion(source, { alongMm: value, acrossMm: 30 }, 'x')).toThrow('长和宽')
    expect(() => createEqualAreaRegion(source, { alongMm: 80, acrossMm: value }, 'x')).toThrow('长和宽')
  })
  it('rejects invalid calibration ranges and centers', () => {
    for (const bad of [{ widthMm: NaN }, { lengthMm: 0 }, { minHeightMm: 2 }, { maxHeightMm: Infinity }]) {
      expect(() => createEqualAreaRegion({ ...source, ...bad }, DEFAULT_EQUAL_AREA_SIZE, 'x')).toThrow('无效')
    }
    expect(() => createEqualAreaRegion(source, DEFAULT_EQUAL_AREA_SIZE, 'x', NaN)).toThrow('无效')
  })
  it('keys jobs and result freshness to the new ROI, actual options, data version and data source', () => {
    const r = createEqualAreaRegion(source, DEFAULT_EQUAL_AREA_SIZE, 'x')
    const first = assessmentSignature('mesh-a', r, options, 'current')
    expect(first).toBe(assessmentSignature('mesh-a', structuredClone(r), { ...options }, 'current'))
    expect(first).not.toBe(assessmentSignature('mesh-a', { ...r, z: [-.1, .1] }, options, 'current'))
    expect(first).not.toBe(assessmentSignature('mesh-b', r, options, 'current'))
    expect(first).not.toBe(assessmentSignature('mesh-a', r, { ...options, stepMm: .2 }, 'current'))
    expect(first).not.toBe(assessmentSignature('mesh-a', r, options, 'original'))
  })
})
