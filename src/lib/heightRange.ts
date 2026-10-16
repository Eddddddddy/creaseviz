import type { RegionBounds } from '../types'
import { assertNotAborted, validateCalibrationValue, validateZagDimensions } from './fileLimits'
import { validateRegion } from './region'
import type { ZagRegionSource } from './zagRegion'

export interface HeightRange {
  min: number
  max: number
}

type Vertex = [x: number, y: number, height: number]

/** A flat selection still needs a nonzero color scale. Values are real mm. */
export function nondegenerateHeightRange(min: number, max: number): HeightRange {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error('高度色范围无效')
  if (min < max) return { min, max }
  const padding = Math.max(0.000001, Math.abs(min) * 0.000001)
  return { min: min - padding, max: max + padding }
}

/** Clip only the edge cells in XY; heights interpolate along the original triangles. */
function clippedTriangleRange(vertices: Vertex[], bounds: RegionBounds): HeightRange | undefined {
  let polygon = vertices
  for (const [axis, limit, direction] of [
    [0, bounds.x[0], 1], [0, bounds.x[1], -1],
    [1, bounds.y[0], 1], [1, bounds.y[1], -1],
  ]) {
    if (!polygon.length) return undefined
    const clipped: Vertex[] = []
    let previous = polygon[polygon.length - 1]
    let previousDistance = (previous[axis] - limit) * direction
    for (const current of polygon) {
      const distance = (current[axis] - limit) * direction
      if ((distance >= 0) !== (previousDistance >= 0)) {
        const t = previousDistance / (previousDistance - distance)
        clipped.push([
          previous[0] + t * (current[0] - previous[0]),
          previous[1] + t * (current[1] - previous[1]),
          previous[2] + t * (current[2] - previous[2]),
        ])
      }
      if (distance >= 0) clipped.push(current)
      previous = current
      previousDistance = distance
    }
    polygon = clipped
  }
  if (polygon.length < 3) return undefined
  // Exclude triangles that only touch an XY boundary (zero surface area).
  let area = 0
  let min = Infinity
  let max = -Infinity
  for (let index = 0; index < polygon.length; index += 1) {
    const vertex = polygon[index]
    const next = polygon[(index + 1) % polygon.length]
    area += (vertex[0] - polygon[0][0]) * (next[1] - polygon[0][1])
      - (next[0] - polygon[0][0]) * (vertex[1] - polygon[0][1])
    min = Math.min(min, vertex[2])
    max = Math.max(max, vertex[2])
  }
  return area === 0 ? undefined : { min, max }
}

const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Read the original calibrated field, not the decimated preview or display scale.
 * Interior cells use scalar extrema without mesh allocation; XY boundary cells
 * interpolate triangle edges. Z clipping intersects the continuous height range,
 * including regions between samples. Yield in short batches without copying data.
 */
export async function zagRegionHeightRange(
  source: ZagRegionSource,
  bounds: RegionBounds,
  signal?: AbortSignal,
): Promise<HeightRange> {
  assertNotAborted(signal)
  validateRegion(bounds)
  const { width, height, xyPitchMm: pitch, zUnitMm: unit } = source.capture
  const dimensions = validateZagDimensions(width, height)
  validateCalibrationValue(pitch, 'XY ')
  validateCalibrationValue(unit, 'Z ')
  if (source.heights.length !== dimensions.pixels || source.maskStride !== dimensions.maskStride
    || source.mask.length !== dimensions.maskBytes) throw new Error('原始高度数据尺寸不匹配')

  const startX = Math.max(0, Math.floor(bounds.x[0] / pitch))
  const endX = Math.min(width - 1, Math.ceil(bounds.x[1] / pitch))
  const startY = Math.max(0, Math.floor(bounds.y[0] / pitch))
  const endY = Math.min(height - 1, Math.ceil(bounds.y[1] / pitch))
  let min = Infinity
  let max = -Infinity
  const include = (low: number, high: number) => {
    const clippedMin = Math.max(low, bounds.z[0])
    const clippedMax = Math.min(high, bounds.z[1])
    if (clippedMin <= clippedMax) {
      min = Math.min(min, clippedMin)
      max = Math.max(max, clippedMax)
    }
  }
  await yieldToMain()
  let batchStarted = performance.now()
  for (let row = startY; row < endY; row += 1) {
    assertNotAborted(signal)
    const y0 = row * pitch
    const y1 = (row + 1) * pitch
    for (let column = startX; column < endX; column += 1) {
      const x0 = column * pitch
      const x1 = (column + 1) * pitch
      const a = row * width + column
      const c = a + width
      const maskA = row * source.maskStride + column
      const maskC = maskA + source.maskStride
      const ha = source.heights[a] * unit
      const hb = source.heights[a + 1] * unit
      const hc = source.heights[c] * unit
      const hd = source.heights[c + 1] * unit
      const interior = x0 >= bounds.x[0] && x1 <= bounds.x[1] && y0 >= bounds.y[0] && y1 <= bounds.y[1]
      const firstValid = source.mask[maskA] !== 2 && source.mask[maskA + 1] !== 2 && source.mask[maskC] !== 2
      const secondValid = source.mask[maskA + 1] !== 2 && source.mask[maskC] !== 2 && source.mask[maskC + 1] !== 2
      if (interior) {
        if (firstValid) include(Math.min(ha, hb, hc), Math.max(ha, hb, hc))
        if (secondValid) include(Math.min(hb, hc, hd), Math.max(hb, hc, hd))
      } else {
        if (firstValid) {
          const range = clippedTriangleRange([[x0, y0, ha], [x0, y1, hc], [x1, y0, hb]], bounds)
          if (range) include(range.min, range.max)
        }
        if (secondValid) {
          const range = clippedTriangleRange([[x1, y0, hb], [x0, y1, hc], [x1, y1, hd]], bounds)
          if (range) include(range.min, range.max)
        }
      }
    }
    if (performance.now() - batchStarted >= 8) {
      await yieldToMain()
      batchStarted = performance.now()
    }
  }
  assertNotAborted(signal)
  if (!Number.isFinite(min)) throw new Error('当前选区内没有有效表面，未修改高度色范围')
  return nondegenerateHeightRange(min, max)
}
