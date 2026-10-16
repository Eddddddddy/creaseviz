import { validateCalibrationValue, validateZagDimensions } from './fileLimits'
import type { ZagRegionSource } from './zagRegion'

export interface SpikeRemovalOptions {
  thresholdUm: number
  radiusMm: number
  direction: 'peaks' | 'both'
}

export interface SpikeRemovalStats {
  changedCount: number
  positiveCount: number
  negativeCount: number
  candidateCount: number
  rejectedComponents: number
  maxChangeMm: number
  effectiveRadiusMm: number
}

export const DEFAULT_SPIKE_OPTIONS: SpikeRemovalOptions = { thresholdUm: 20, radiusMm: 0.3, direction: 'peaks' }

/**
 * A conservative, single-pass outlier repair, not a surface smoothing filter.
 * Four opposite sample pairs predict the center on a locally tilted surface.
 * ALL directions must disagree with the center by the physical threshold.
 * Only small 8-connected islands are repaired; long creases and missing-data
 * neighborhoods are protected. Replacements always read the unmodified input.
 * This cannot distinguish a real isolated defect from a measurement artifact.
 */
export function removeZagSpikes(
  source: ZagRegionSource,
  options: SpikeRemovalOptions,
  onProgress?: (progress: number) => void,
): { heights: Int32Array; stats: SpikeRemovalStats } {
  const { width, height, xyPitchMm: pitch, zUnitMm: unit } = source.capture
  const dimensions = validateZagDimensions(width, height)
  validateCalibrationValue(pitch, 'XY ')
  validateCalibrationValue(unit, 'Z ')
  if (source.heights.length !== dimensions.pixels || source.maskStride !== dimensions.maskStride
    || source.mask.length !== dimensions.maskBytes) throw new Error('去尖刺高度数据尺寸不匹配')
  if (!Number.isFinite(options.thresholdUm) || options.thresholdUm < 1 || options.thresholdUm > 1000
    || !Number.isFinite(options.radiusMm) || options.radiusMm < 0.05 || options.radiusMm > 2
    || !['peaks', 'both'].includes(options.direction)) throw new Error('去尖刺参数无效')

  // Bound memory and avoid unbounded neighborhoods on very fine scans.
  const radius = Math.max(1, Math.min(64, Math.round(options.radiusMm / pitch)))
  const stats: SpikeRemovalStats = {
    changedCount: 0, positiveCount: 0, negativeCount: 0, candidateCount: 0,
    rejectedComponents: 0, maxChangeMm: 0, effectiveRadiusMm: radius * pitch,
  }
  const heights = source.heights.slice()
  if (width <= radius * 2 + 2 || height <= radius * 2 + 2) return { heights, stats }
  const flags = new Uint8Array(dimensions.pixels)
  const invalidColumns = new Uint16Array(width)
  const offsets = [radius, radius * width, radius * (width + 1), radius * (width - 1)]
  const threshold = options.thresholdUm / 1000 / unit
  const predictions = (index: number): [number, number, number, number] => [
    (source.heights[index - offsets[0]] + source.heights[index + offsets[0]]) / 2,
    (source.heights[index - offsets[1]] + source.heights[index + offsets[1]]) / 2,
    (source.heights[index - offsets[2]] + source.heights[index + offsets[2]]) / 2,
    (source.heights[index - offsets[3]] + source.heights[index + offsets[3]]) / 2,
  ]
  for (let y = 0; y <= radius * 2; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (source.mask[y * source.maskStride + x] === 2) invalidColumns[x] += 1
    }
  }
  for (let y = radius; y < height - radius; y += 1) {
    let invalid = 0
    for (let x = 0; x <= radius * 2; x += 1) invalid += invalidColumns[x]
    for (let x = radius; x < width - radius; x += 1) {
      if (invalid === 0) {
        const index = y * width + x
        const [a, b, c, d] = predictions(index)
        const value = source.heights[index]
        const peak = value - Math.max(a, b, c, d) > threshold
        const dip = options.direction === 'both' && Math.min(a, b, c, d) - value > threshold
        if (peak || dip) {
          flags[index] = peak ? 1 : 2
          stats.candidateCount += 1
        }
      }
      invalid -= invalidColumns[x - radius]
      if (x + radius + 1 < width) invalid += invalidColumns[x + radius + 1]
    }
    if (stats.candidateCount > Math.min(1_000_000, dimensions.pixels * 0.05)) {
      throw new Error('超过 5% 或 100 万点被判为候选异常，已停止修复；请提高高度阈值或减小邻域')
    }
    if (y + radius + 1 < height) {
      for (let x = 0; x < width; x += 1) {
        if (source.mask[(y - radius) * source.maskStride + x] === 2) invalidColumns[x] -= 1
        if (source.mask[(y + radius + 1) * source.maskStride + x] === 2) invalidColumns[x] += 1
      }
    }
    if (y % 32 === 0) onProgress?.(0.7 * y / height)
  }
  onProgress?.(0.7)
  const queue = new Int32Array(stats.candidateCount)
  const maxSpan = 2 * radius + 1
  for (let index = 0; index < flags.length; index += 1) {
    const sign = flags[index]
    if (sign !== 1 && sign !== 2) continue
    let count = 1
    let cursor = 0
    queue[0] = index
    flags[index] = 3
    let minX = width, maxX = 0, minY = height, maxY = 0
    while (cursor < count) {
      const point = queue[cursor++]
      const x = point % width
      const y = Math.floor(point / width)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue
          const neighbor = point + dy * width + dx
          if (flags[neighbor] !== sign) continue
          flags[neighbor] = 3
          queue[count++] = neighbor
        }
      }
    }
    if (maxX - minX + 1 > maxSpan || maxY - minY + 1 > maxSpan
      || minX <= radius || minY <= radius || maxX >= width - radius - 1 || maxY >= height - radius - 1) {
      stats.rejectedComponents += 1
      continue
    }
    for (let point = 0; point < count; point += 1) {
      const target = queue[point]
      const [a, b, c, d] = predictions(target)
      // Median of the four pairwise plane predictions, in original int32 units.
      const replacement = Math.round((a + b + c + d - Math.min(a, b, c, d) - Math.max(a, b, c, d)) / 2)
      heights[target] = replacement
      stats.changedCount += 1
      if (sign === 1) stats.positiveCount += 1
      else stats.negativeCount += 1
      stats.maxChangeMm = Math.max(stats.maxChangeMm, Math.abs(replacement - source.heights[target]) * unit)
    }
    if (index % 4096 === 0) onProgress?.(0.7 + 0.3 * index / flags.length)
  }
  onProgress?.(1)
  return { heights, stats }
}
