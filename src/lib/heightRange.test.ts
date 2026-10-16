import { describe, expect, it } from 'vitest'
import { nondegenerateHeightRange, zagRegionHeightRange } from './heightRange'
import { buildZagRegionMesh } from './zagRegion'
import type { RegionBounds } from '../types'

function field(width = 5, height = 5) {
  const maskStride = Math.ceil(width / 4) * 4
  return {
    heights: Int32Array.from({ length: width * height }, (_, i) => i % width * 10 + Math.floor(i / width)),
    mask: new Uint8Array(maskStride * height), maskStride,
    capture: { width, height, xyPitchMm: 1, zUnitMm: 0.1 },
  }
}
const bounds: RegionBounds = { x: [1, 3], y: [1, 3], z: [-100, 100] }

describe('selected auto height range', () => {
  it('uses only the selected XY surface and the original mm calibration', async () => {
    const source = field()
    source.heights[0] = -10000
    source.heights[24] = 10000
    expect(await zagRegionHeightRange(source, bounds)).toEqual({ min: 1.1, max: 3.3000000000000003 })
  })

  it('honors Z clipping even when no original vertex is within the Z interval', async () => {
    const source = field(2, 2)
    source.heights.set([0, 100, 0, 100])
    expect(await zagRegionHeightRange(source, { x: [0, 1], y: [0, 1], z: [4, 6] }))
      .toEqual({ min: 4, max: 6 })
  })

  it('interpolates narrow XY regions between original samples instead of using outside heights', async () => {
    const source = field(2, 2)
    source.heights.set([0, 100, 0, 100])
    const range = await zagRegionHeightRange(source, { x: [0.25, 0.35], y: [0.4, 0.6], z: [-100, 100] })
    expect(range.min).toBeCloseTo(2.5)
    expect(range.max).toBeCloseTo(3.5)
  })

  it('excludes invalid-mask samples and triangles, and reports empty selections', async () => {
    const source = field(3, 3)
    source.heights[0] = -10000
    source.mask[0] = 2
    const range = await zagRegionHeightRange(source, { x: [0, 2], y: [0, 2], z: [-10000, 10000] })
    expect(range.min).toBeCloseTo(0.1)
    source.mask.fill(2)
    await expect(zagRegionHeightRange(source, bounds)).rejects.toThrow(/没有有效表面/)
    await expect(zagRegionHeightRange(field(), { ...bounds, z: [30, 40] })).rejects.toThrow(/没有有效表面/)
  })

  it('agrees with exact original-quality OBJ clipping for fractional XYZ selections', async () => {
    const source = field(8, 7)
    for (let index = 0; index < source.heights.length; index += 1) source.heights[index] = (index * 17 % 103) - 40
    source.mask[2 * source.maskStride + 3] = 2
    for (const selection of [
      { x: [0.2, 5.7], y: [1.3, 4.9], z: [-0.7, 1.8] },
      { x: [4.35, 4.45], y: [2.55, 2.65], z: [-10, 10] },
      { x: [1, 5], y: [1, 5], z: [-10, 10] },
    ] as RegionBounds[]) {
      const mesh = buildZagRegionMesh(source, selection, 'original')
      const heights = mesh.positions.filter((_, index) => index % 3 === 1)
      const range = await zagRegionHeightRange(source, selection)
      expect(range.min).toBeCloseTo(Math.min(...heights), 5)
      expect(range.max).toBeCloseTo(Math.max(...heights), 5)
    }
  })

  it('expands a constant-height range just enough for a valid color scale', async () => {
    const source = field()
    source.heights.fill(7)
    const range = await zagRegionHeightRange(source, bounds)
    expect(range.min).toBeCloseTo(0.699999, 7)
    expect(range.max).toBeCloseTo(0.700001, 7)
    expect(() => nondegenerateHeightRange(NaN, 1)).toThrow(/无效/)
  })

  it('rejects invalid regions and damaged source data', async () => {
    await expect(zagRegionHeightRange(field(), { ...bounds, x: [1, 1] })).rejects.toThrow(/无效/)
    await expect(zagRegionHeightRange({ ...field(), heights: new Int32Array(1) }, bounds)).rejects.toThrow(/尺寸不匹配/)
    await expect(zagRegionHeightRange(field(), { ...bounds, x: [20, 30] })).rejects.toThrow(/没有有效表面/)
  })

  it('cancels an obsolete calculation before and after yielding to the UI', async () => {
    const controller = new AbortController()
    const calculation = zagRegionHeightRange(field(), bounds, controller.signal)
    controller.abort()
    await expect(calculation).rejects.toMatchObject({ name: 'AbortError' })
    await expect(zagRegionHeightRange(field(), bounds, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
