import { describe, expect, it } from 'vitest'
import { clipMeshToRegion, validateRegion } from './region'
import { buildZagRegionMesh } from './zagRegion'
import { createObjBlob } from './objExport'
import type { RegionBounds } from '../types'

const full: RegionBounds = { x: [0, 2], y: [0, 2], z: [-1, 3] }
const square = {
  positions: new Float32Array([0, 0, 0, 2, 2, 0, 0, 0, 2, 2, 2, 2]),
  indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
  uvs: new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]),
}

describe('XYZ region clipping', () => {
  it('clips crossing triangles at exact XY and height boundaries, preserves winding and interpolates UV', () => {
    const bounds: RegionBounds = { x: [0.25, 1.75], y: [0.5, 1.5], z: [0.75, 1.25] }
    const clipped = clipMeshToRegion(square, bounds)
    let area = 0
    for (let index = 0; index < clipped.positions.length / 3; index += 1) {
      const [x, height, y] = clipped.positions.slice(index * 3, index * 3 + 3)
      expect(x).toBeGreaterThanOrEqual(0.75)
      expect(x).toBeLessThanOrEqual(1.25)
      expect(y).toBeGreaterThanOrEqual(0.5)
      expect(y).toBeLessThanOrEqual(1.5)
      expect(height).toBeCloseTo(x)
      expect(clipped.uvs?.[index * 2]).toBeCloseTo(x / 2)
      expect(clipped.uvs?.[index * 2 + 1]).toBeCloseTo(1 - y / 2)
    }
    for (let offset = 0; offset < clipped.indices.length; offset += 3) {
      const [a, b, c] = clipped.indices.slice(offset, offset + 3)
      const ax = clipped.positions[a * 3], ay = clipped.positions[a * 3 + 2]
      const bx = clipped.positions[b * 3], by = clipped.positions[b * 3 + 2]
      const cx = clipped.positions[c * 3], cy = clipped.positions[c * 3 + 2]
      const signed = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2
      expect(signed).toBeLessThan(0)
      area += -signed
    }
    expect(area).toBeCloseTo(0.5)
  })

  it('retains the full surface without unused vertices, rejects empty and invalid regions', () => {
    expect(clipMeshToRegion(square, full).indices).toHaveLength(6)
    expect(clipMeshToRegion(square, full).positions).toHaveLength(12)
    expect(() => clipMeshToRegion(square, { ...full, z: [4, 5] })).toThrow(/没有有效表面/)
    expect(() => validateRegion({ ...full, x: [1, 1] })).toThrow(/X 选区范围无效/)
    expect(() => validateRegion({ ...full, z: [Number.NaN, 1] })).toThrow(/Z 选区范围无效/)
    expect(() => clipMeshToRegion(square, full, 2)).toThrow(/超过/)
  })

  it('preserves millimeter selection bounds before exaggerated OBJ display scaling', async () => {
    const bounds: RegionBounds = { x: [0.5, 1.5], y: [0.5, 1.5], z: [0.75, 1.25] }
    const mesh = clipMeshToRegion(square, bounds)
    const { blob } = createObjBlob({
      ...mesh, name: 'selection', region: bounds,
      scaleX: 2, scaleY: 3, scaleZ: 10, scaleMode: 'display',
    })
    const text = await blob.text()
    expect(text).toContain('# Region (mm, before scale): X 0.5..1.5; Y 0.5..1.5; Z 0.75..1.25')
    for (const line of text.split('\n').filter((line) => line.startsWith('v '))) {
      const [, x, y, z] = line.split(' ').map(Number)
      expect(x).toBeGreaterThanOrEqual(1.5)
      expect(x).toBeLessThanOrEqual(2.5)
      expect(y).toBeGreaterThanOrEqual(1.5)
      expect(y).toBeLessThanOrEqual(4.5)
      expect(z).toBeGreaterThanOrEqual(7.5)
      expect(z).toBeLessThanOrEqual(12.5)
    }
  })
})

function field(width: number, height: number) {
  const maskStride = Math.ceil(width / 4) * 4
  return {
    heights: new Int32Array(width * height).fill(10),
    mask: new Uint8Array(maskStride * height),
    maskStride,
    capture: { width, height, xyPitchMm: 0.1, zUnitMm: 0.01 },
  }
}

describe('original ZAG region mesh', () => {
  it('regenerates a small selection from every original pixel and drops invalid samples', () => {
    const source = field(11, 11)
    const bounds: RegionBounds = { x: [0.2, 0.6], y: [0.2, 0.6], z: [-1, 1] }
    const fullMesh = buildZagRegionMesh(source, bounds, 'high')
    expect(fullMesh.sampleStep).toBe(1)
    source.mask[4 * source.maskStride + 4] = 2
    const masked = buildZagRegionMesh(source, bounds, 'original')
    expect(masked.indices.length).toBeLessThan(fullMesh.indices.length)
    for (let i = 0; i < masked.positions.length; i += 3) {
      expect(Math.abs(masked.positions[i] - 0.4) + Math.abs(masked.positions[i + 2] - 0.4)).toBeGreaterThan(1e-7)
    }
  })

  it('adapts large and narrow selections to the point budget while preserving the last row', () => {
    const source = field(5000, 50)
    const result = buildZagRegionMesh(source, { x: [0, 499.9], y: [0, 4.9], z: [-1, 1] }, 'preview')
    expect(result.sampleStep).toBeGreaterThan(1)
    expect(result.positions.length / 3).toBeLessThanOrEqual(200_000)
    expect(Math.max(...result.positions.filter((_, i) => i % 3 === 2))).toBeCloseTo(4.9)
  })

  it('rejects oversized original export before creating mesh arrays and rejects damaged buffers', () => {
    const source = field(1000, 1000)
    expect(() => buildZagRegionMesh(source, { x: [0, 99.9], y: [0, 99.9], z: [-1, 1] }, 'original'))
      .toThrow(/超过原始采样导出上限/)
    expect(() => buildZagRegionMesh({ ...source, heights: new Int32Array(1) }, full, 'high'))
      .toThrow(/尺寸不匹配/)
  })
})
