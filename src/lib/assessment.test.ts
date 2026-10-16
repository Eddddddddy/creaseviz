import { describe, expect, it } from 'vitest'
import { ASSESSMENT_MAX_CELLS, assessZagSurface, assessmentSlopeMaps, validateAssessmentOptions } from './assessment'
import { DEFAULT_ASSESSMENT_OPTIONS as defaults, type AssessmentOptions } from './assessmentTypes'
import { finiteSorted, fitAssessmentPlane, gaussianField, heightMetrics, quantileSorted } from './assessmentMath'
import type { ZagRegionSource } from './zagRegion'
import type { RegionBounds } from '../types'

function field(nx = 61, ny = 41, pitch = .25, fn = (x: number, y: number) => .003 * x - .002 * y + .2): ZagRegionSource {
  const stride = Math.ceil(nx / 4) * 4
  return { capture: { width: nx, height: ny, xyPitchMm: pitch, zUnitMm: 1e-7 }, maskStride: stride,
    heights: Int32Array.from({ length: nx * ny }, (_, i) => Math.round(fn((i % nx) * pitch, Math.floor(i / nx) * pitch) / 1e-7)),
    mask: new Uint8Array(stride * ny) }
}
function full(source: ZagRegionSource): RegionBounds {
  return { x: [0, (source.capture.width - 1) * source.capture.xyPitchMm], y: [0, (source.capture.height - 1) * source.capture.xyPitchMm], z: [-100, 100] }
}
const options = { ...defaults, stepMm: .25, sigmaMm: 0, bowSigmaMm: 1 }

describe('assessment mathematical definitions', () => {
  it('interpolates percentiles and does not mutate source values', () => {
    const v = new Float64Array([3, 1, NaN, 2, 4]), sorted = finiteSorted(v)
    expect(Array.from(sorted)).toEqual([1, 2, 3, 4])
    expect(quantileSorted(sorted, .5)).toBe(2.5)
    expect(quantileSorted(sorted, .99)).toBeCloseTo(3.97)
    expect(v[0]).toBe(3)
  })
  it('reports RMS, absolute mean, PV, F98 and height moments correctly', () => {
    const m = heightMetrics(new Float64Array([-.003, -.001, .001, .003, NaN]))
    expect(m.count).toBe(4); expect(m.rmsUm).toBeCloseTo(Math.sqrt(5))
    expect(m.meanAbsUm).toBeCloseTo(2); expect(m.pvUm).toBeCloseTo(6)
    expect(m.f98Um).toBeCloseTo(5.88); expect(m.f90Um).toBeCloseTo(5.4)
    expect(m.skewness).toBeCloseTo(0); expect(m.kurtosis).toBeCloseTo(41 / 25)
    expect(heightMetrics(new Float64Array(10)).kurtosis).toBeNull()
  })
  it.each([0, .25, .5])('preserves a perfectly tilted plane with sigma %s', (sigma) => {
    const source = field(), before = source.heights.slice()
    const result = assessZagSurface(source, full(source), { ...options, sigmaMm: sigma })
    expect(result.surface.rmsUm).toBeLessThan(1e-6); expect(result.surface.pvUm).toBeLessThan(1e-5)
    expect(result.slopes?.normal.p99Deg).toBeLessThan(1e-7)
    expect(result.plane[0]).toBeCloseTo(.003, 9); expect(result.plane[1]).toBeCloseTo(-.002, 9)
    expect(source.heights).toEqual(before); expect(result.grid.coveragePct).toBe(100)
    expect(result.slopes?.cross.grade95Pct).toBeLessThan(1e-6)
  })
  it('uses stable coordinates and robust fitting rejects isolated influence, not source points', () => {
    const xs = Float64Array.from({ length: 20 }, (_, i) => 100000 + i * .1)
    const ys = Float64Array.from({ length: 15 }, (_, i) => 200000 + i * .1)
    const h = Float64Array.from({ length: 300 }, (_, i) => .002 * xs[i % 20] - .004 * ys[Math.floor(i / 20)] + .1)
    h[25] += 2
    const ordinary = fitAssessmentPlane(h, xs, ys), robust = fitAssessmentPlane(h, xs, ys, true)
    expect(Math.abs(robust[0] - .002)).toBeLessThan(Math.abs(ordinary[0] - .002) / 100)
    expect(h[25]).toBeGreaterThan(h[24])
  })
  it('does not zero-fill or create heights at a missing center', () => {
    const h = new Float64Array(41 * 41).fill(0.5); h[20 * 41 + 20] = NaN
    const sm = gaussianField(h, 41, 41, 2, 2)
    expect(Number.isNaN(sm[20 * 41 + 20])).toBe(true)
    expect(sm[0]).toBeCloseTo(.5)
    expect(finiteSorted(sm).length).toBeLessThan(h.length - 1)
  })
})

describe('XYZ selection and analysis quality', () => {
  it('uses exact physical ROI and explicit inner margins', () => {
    const source = field(81, 81)
    const roi: RegionBounds = { x: [2, 17], y: [3, 18], z: [-1, 1] }
    const r = assessZagSurface(source, roi, { ...options, edgeMarginMm: 1 })
    expect(r.bounds).toEqual({ x: [3, 16], y: [4, 17], z: [-1, 1] })
    expect(r.grid.eligibleAreaMm2).toBeCloseTo(169)
    expect(r.sourcePoints.selected).toBe(53 * 53)
  })
  it('filters by Z before statistics, warns about truncated height populations', () => {
    const source = field(81, 81, .25, (x) => .01 * x)
    const r = assessZagSurface(source, { ...full(source), z: [.05, .15] }, options)
    expect(r.grid.rawCoveragePct).toBeGreaterThan(45); expect(r.grid.rawCoveragePct).toBeLessThan(55)
    expect(r.sourcePoints.selected).toBeLessThan(r.sourcePoints.valid)
    expect(r.sourcePoints.minMm).toBeGreaterThanOrEqual(.05)
    expect(r.sourcePoints.maxMm).toBeLessThanOrEqual(.15)
    expect(r.warnings.some((w) => w.startsWith('Z 选区'))).toBe(true)
  })
  it('reports incomplete source masks and never turns them into a flat zero area', () => {
    const source = field()
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) source.mask[y * source.maskStride + x] = 2
    const r = assessZagSurface(source, full(source), options)
    expect(r.grid.coveragePct).toBeLessThan(90)
    expect(r.maps.residualUm.some((v) => v === null)).toBe(true)
    expect(r.surface.rmsUm).toBeLessThan(1e-6)
  })
  it('adapts huge target grids to a bounded budget and reports actual spacing', () => {
    const source = field(1001, 1001, .1)
    const r = assessZagSurface(source, full(source), { ...options, stepMm: .02, bowSigmaMm: .5 })
    expect(r.grid.nx * r.grid.ny).toBeLessThanOrEqual(ASSESSMENT_MAX_CELLS)
    expect(r.grid.dxMm).toBeGreaterThan(.1)
    expect(r.warnings.some((v) => v.includes('60 万格'))).toBe(true)
  })
  it('does not invent fold metrics in a narrow ROI without shoulders', () => {
    const source = field()
    const r = assessZagSurface(source, full(source), options)
    expect(r.crease.validBands).toBe(0); expect(r.crease.summary).toBeNull()
    expect(r.warnings.some((v) => v.includes('折痕指标不可用'))).toBe(true)
  })
  it('returns no central metric when the configured hinge lies outside ROI', () => {
    const source = field()
    const r = assessZagSurface(source, full(source), { ...options, hingeCenterMm: 99 })
    expect(r.central).toBeNull(); expect(r.centralSlopes).toBeNull()
  })
  it('rejects missing data, empty Z, out-of-source XY, small grids and wrong buffers', () => {
    const source = field()
    expect(() => assessZagSurface(source, { ...full(source), z: [9, 10] }, options)).toThrow('没有有效表面')
    expect(() => assessZagSurface(source, { ...full(source), x: [99, 100] }, options)).toThrow('选区范围无效')
    expect(() => assessZagSurface(source, { ...full(source), x: [0, .2] }, options)).toThrow('选区过窄')
    expect(() => assessZagSurface({ ...source, heights: new Int32Array(4) }, full(source), options)).toThrow('尺寸不匹配')
    source.mask.fill(2)
    expect(() => assessZagSurface(source, full(source), options)).toThrow('没有有效表面')
  })
  it.each([{ stepMm: NaN }, { sigmaMm: -1 }, { stepMm: 0 }, { edgeMarginMm: 21 }, { coreHalfWidthMm: 9 }, { shoulderOuterMm: 4 }, { angleThresholdDeg: 0 }, { plane: 'bad' }, { hingeCenterMm: Infinity }])('rejects invalid options %j', (invalid) => {
    expect(() => validateAssessmentOptions({ ...defaults, ...invalid } as AssessmentOptions)).toThrow()
  })
})

describe('physical slope and crease methods', () => {
  it('matches analytic directional angles and independent normal-dot geometry', () => {
    const nx = 51, ny = 51, step = .1, xs = Float64Array.from({ length: nx }, (_, i) => i * step), ys = xs.slice()
    const a = .002, b = -.003
    const h = Float64Array.from({ length: nx * ny }, (_, i) => a * xs[i % nx] + b * ys[Math.floor(i / nx)] + .01 * ys[Math.floor(i / nx)] ** 2)
    const maps = assessmentSlopeMaps(h, nx, ny, step, step, [a, b, 0], xs, ys, defaults, 2.5)
    const i = 25 * nx + 25, gx = a, gy = b + .02 * 2.5
    const expected = (Math.atan(gy) - Math.atan(b)) * 180 / Math.PI
    expect(maps.crossMap[i]).toBeCloseTo(expected, 8)
    const dot = (gx * a + gy * b + 1) / (Math.hypot(gx, gy, 1) * Math.hypot(a, b, 1))
    expect(maps.normalMap[i]).toBeCloseTo(Math.acos(dot) * 180 / Math.PI, 7)
    expect(maps.all?.along.p95Deg).toBeLessThan(1e-8)
    expect(maps.all?.crossEnergyPct).toBeCloseTo(100)
    expect(maps.all?.cross.grade95Pct).toBeCloseTo(Math.tan(maps.all!.cross.p95Deg / 180 * Math.PI) * 100)
  })
  it.each(['x', 'y'] as const)('recovers Gaussian groove depth, width and area with hinge axis %s', (axis) => {
    const source = axis === 'x' ? field(321, 161, .25, (x, y) => .002 * x - .001 * y - .08 * Math.exp(-.5 * ((y - 20) / 2) ** 2))
      : field(161, 321, .25, (x, y) => .002 * x - .001 * y - .08 * Math.exp(-.5 * ((x - 20) / 2) ** 2))
    const result = assessZagSurface(source, full(source), { ...options, hingeAxis: axis, bowSigmaMm: 2 })
    expect(result.crease.validBands).toBe(16)
    expect(result.crease.summary?.depthUm.p50).toBeCloseTo(80, 0)
    expect(result.crease.summary?.width50Mm?.p50).toBeCloseTo(2 * Math.sqrt(2 * Math.log(2)) * 2, 1)
    expect(result.crease.summary?.absAreaUmMm?.p50).toBeCloseTo(80 * Math.sqrt(2 * Math.PI) * 2, 0)
    expect(result.slopes?.cross.p95Deg).toBeGreaterThan(result.slopes!.along.p95Deg * 10)
  })
  it('reports a broad hump as bulge, not negative groove depth', () => {
    const source = field(321, 161, .25, (_, y) => .06 * Math.exp(-.5 * ((y - 20) / 2) ** 2))
    const r = assessZagSurface(source, full(source), { ...options, bowSigmaMm: 2 })
    expect(r.crease.summary?.bulgeUm.p50).toBeCloseTo(60, 0)
    expect(r.crease.summary?.depthUm.p50).toBeLessThan(.1)
  })
  it('calculates optional scale sensitivity with shared bounds and sampling', () => {
    const source = field(101, 101, .25, (_, y) => .01 * Math.cos(y * 2))
    const r = assessZagSurface(source, full(source), { ...options, sensitivity: true })
    expect(r.sensitivity.map((v) => v.sigmaMm)).toEqual([.15, .5])
    expect(r.sensitivity[1].rmsUm).toBeLessThan(r.sensitivity[0].rmsUm)
  })
})
