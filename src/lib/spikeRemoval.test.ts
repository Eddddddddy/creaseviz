import { describe, expect, it } from 'vitest'
import { DEFAULT_SPIKE_OPTIONS, removeZagSpikes } from './spikeRemoval'
import { buildZagRegionMesh, type ZagRegionSource } from './zagRegion'
import { createObjBlob } from './objExport'
import { zagRegionHeightRange } from './heightRange'

function field(width = 61, height = 61, pitch = 0.1, sample = (x: number, y: number) => x * 10 + y * 20): ZagRegionSource {
  const maskStride = Math.ceil(width / 4) * 4
  return {
    heights: Int32Array.from({ length: width * height }, (_, i) => Math.round(sample(i % width, Math.floor(i / width)))),
    mask: new Uint8Array(maskStride * height), maskStride,
    capture: { width, height, xyPitchMm: pitch, zUnitMm: 0.00001 },
  }
}

const center = 30 * 61 + 30

describe('isolated spike removal', () => {
  it('does not smooth a tilted plane and never mutates input arrays', () => {
    const source = field()
    const before = source.heights.slice(), mask = source.mask.slice()
    const result = removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS)
    expect(result.heights).toEqual(before)
    expect(result.heights).not.toBe(source.heights)
    expect(source.heights).toEqual(before)
    expect(source.mask).toEqual(mask)
    expect(result.stats.changedCount).toBe(0)
  })

  it('repairs a positive isolated spike to the local tilted plane', () => {
    const source = field(), expected = source.heights[center]
    source.heights[center] += 12000
    const result = removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS)
    expect(result.heights[center]).toBe(expected)
    expect(result.stats.changedCount).toBe(1)
    expect(result.stats.positiveCount).toBe(1)
    expect(result.stats.maxChangeMm).toBeCloseTo(0.12)
    expect(source.heights[center]).toBe(expected + 12000)
    for (let i = 0; i < source.heights.length; i++) {
      if (i !== center) expect(result.heights[i]).toBe(source.heights[i])
    }
  })

  it('leaves downward outliers unchanged by default, repairs them only in both mode', () => {
    const source = field(), expected = source.heights[center]
    source.heights[center] -= 20000
    expect(removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS).stats.changedCount).toBe(0)
    const result = removeZagSpikes(source, { ...DEFAULT_SPIKE_OPTIONS, direction: 'both' })
    expect(result.heights[center]).toBe(expected)
    expect(result.stats.negativeCount).toBe(1)
  })

  it('respects the height threshold in calibrated micrometers', () => {
    const source = field()
    source.heights[center] += 1500
    expect(removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS).stats.changedCount).toBe(0)
    expect(removeZagSpikes(source, { ...DEFAULT_SPIKE_OPTIONS, thresholdUm: 10 }).stats.changedCount).toBe(1)
  })

  it('retains smooth broad creases and bumps', () => {
    const source = field(151, 101, 0.1, (x, y) => 10 * x + 20 * y - 20000 * Math.exp(-(((x - 75) / 20) ** 2)))
    const result = removeZagSpikes(source, { ...DEFAULT_SPIKE_OPTIONS, direction: 'both' })
    expect(result.heights).toEqual(source.heights)
  })

  it.each(['horizontal', 'vertical', 'diagonal'])('retains a very narrow long %s crease', (orientation) => {
    const source = field(101, 101, 0.1, (x, y) => {
      const onLine = orientation === 'horizontal' ? y === 50 : orientation === 'vertical' ? x === 50 : x === y
      return onLine ? 100000 : 0
    })
    expect(removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS).heights).toEqual(source.heights)
  })

  it('protects elongated connected features not parallel to the four prediction axes', () => {
    const source = field(151, 101, 0.1, (x, y) => Math.abs(y - 0.3 * x - 20) < 1 ? 20000 : 0)
    const result = removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS)
    expect(result.heights).toEqual(source.heights)
    expect(result.stats.rejectedComponents).toBeGreaterThan(0)
  })

  it('repairs a small cluster without touching other points', () => {
    const source = field()
    const expected = source.heights.slice()
    for (const offset of [0, 1, 61, 62]) source.heights[center + offset] += 10000
    const result = removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS)
    expect(result.stats.changedCount).toBe(4)
    expect(result.heights).toEqual(expected)
  })

  it('does not fill missing data or repair anywhere in its reference neighborhood', () => {
    const source = field()
    source.heights[center] += 10000
    source.mask[29 * source.maskStride + 28] = 2
    source.heights[29 * 61 + 28] = -2147483648
    expect(removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS).heights).toEqual(source.heights)
  })

  it('handles padded masks, a missing-data strip, and edge spikes conservatively', () => {
    const source = field(63, 61)
    for (let y = 0; y < 61; y++) source.mask[y * source.maskStride + 30] = 2
    source.heights[30 * 63 + 31] += 10000
    source.heights[0] += 100000
    expect(removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS).heights).toEqual(source.heights)
  })

  it('uses physical radius at different sampling pitches', () => {
    for (const pitch of [0.05, 0.1]) {
      const source = field(61, 61, pitch)
      source.heights[center] += 10000
      const result = removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS)
      expect(result.stats.effectiveRadiusMm).toBeCloseTo(0.3)
      expect(result.stats.changedCount).toBe(1)
    }
  })

  it('caps the neighborhood at 64 pixels and reports its actual size', () => {
    const source = field(151, 151, 0.001)
    const result = removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS)
    expect(result.stats.effectiveRadiusMm).toBe(0.064)
  })

  it('safely handles small fields and completely missing fields', () => {
    const small = field(2, 2)
    expect(removeZagSpikes(small, DEFAULT_SPIKE_OPTIONS).heights).toEqual(small.heights)
    const missing = field()
    missing.mask.fill(2)
    expect(removeZagSpikes(missing, DEFAULT_SPIKE_OPTIONS).stats.changedCount).toBe(0)
  })

  it('refuses overly aggressive candidate coverage without changing the input', () => {
    const source = field(101, 101, 0.1, (x, y) => x % 4 === 0 && y % 4 === 0 ? 100000 : 0)
    const before = source.heights.slice()
    expect(() => removeZagSpikes(source, { ...DEFAULT_SPIKE_OPTIONS, radiusMm: 0.1 })).toThrow('超过 5%')
    expect(source.heights).toEqual(before)
  })

  it.each([
    { thresholdUm: 0 }, { thresholdUm: NaN }, { thresholdUm: 1001 },
    { radiusMm: 0 }, { radiusMm: Infinity }, { radiusMm: 3 }, { direction: 'bad' },
  ])('rejects invalid settings %j', (invalid) => {
    expect(() => removeZagSpikes(field(), { ...DEFAULT_SPIKE_OPTIONS, ...invalid } as typeof DEFAULT_SPIKE_OPTIONS)).toThrow('参数无效')
  })

  it('rejects malformed fields', () => {
    expect(() => removeZagSpikes({ ...field(), maskStride: 1 }, DEFAULT_SPIKE_OPTIONS)).toThrow('尺寸不匹配')
  })

  it('uses repaired physical heights for region range and original-sampling OBJ', async () => {
    const source = field(61, 61, 0.1, () => 0)
    source.heights[center] = 50000
    const repaired = { ...source, heights: removeZagSpikes(source, DEFAULT_SPIKE_OPTIONS).heights }
    const bounds = { x: [2, 4], y: [2, 4], z: [-1, 1] } as { x: [number, number]; y: [number, number]; z: [number, number] }
    const mesh = buildZagRegionMesh(repaired, bounds, 'original')
    for (let i = 1; i < mesh.positions.length; i += 3) expect(mesh.positions[i]).toBe(0)
    expect((await zagRegionHeightRange(source, bounds)).max).toBe(0.5)
    expect((await zagRegionHeightRange(repaired, bounds)).max).toBeLessThan(0.00001)
    const result = createObjBlob({ ...mesh, name: 'test', scaleX: 1, scaleY: 1, scaleZ: 1, scaleMode: 'true',
      spikeRepair: { thresholdUm: 20, radiusMm: 0.3, direction: 'peaks', changedCount: 1 } })
    const text = await result.blob.text()
    expect(text).toContain('# Processing: isolated spike repair;')
    expect(text).toContain('changed 1 points')
    const z = text.split('\n').filter((line) => line.startsWith('v ')).map((line) => Number(line.split(' ')[3]))
    expect(Math.max(...z)).toBe(0)
  })
})
