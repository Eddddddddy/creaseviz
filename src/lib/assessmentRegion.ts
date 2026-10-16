import type { AssessmentOptions } from './assessmentTypes'
import type { RegionBounds } from '../types'
import { fullModelRegion, validateRegion } from './region'

export interface EqualAreaSize { alongMm: number; acrossMm: number }
export const DEFAULT_EQUAL_AREA_SIZE: EqualAreaSize = { alongMm: 80, acrossMm: 30 }

/** Fixed geometry, never a search for the flattest patch or a silently smaller area. */
export function createEqualAreaRegion(
  source: { widthMm: number; lengthMm: number; minHeightMm: number; maxHeightMm: number },
  size: EqualAreaSize,
  hingeAxis: AssessmentOptions['hingeAxis'],
  hingeCenterMm: number | null = null,
): RegionBounds {
  if (![size.alongMm, size.acrossMm].every((v) => Number.isFinite(v) && v > 0 && v <= 1000)) {
    throw new Error('同面积区域的长和宽必须为大于 0、且不超过 1000 mm 的数值')
  }
  if (![source.widthMm, source.lengthMm].every((v) => Number.isFinite(v) && v > 0)
    || !Number.isFinite(source.minHeightMm) || !Number.isFinite(source.maxHeightMm)
    || source.minHeightMm > source.maxHeightMm || !['x', 'y'].includes(hingeAxis)
    || (hingeCenterMm !== null && !Number.isFinite(hingeCenterMm))) {
    throw new Error('扫描标定范围或转轴位置无效，无法自动取区')
  }
  const sx = hingeAxis === 'x' ? size.alongMm : size.acrossMm
  const sy = hingeAxis === 'x' ? size.acrossMm : size.alongMm
  if (sx > source.widthMm || sy > source.lengthMm) {
    throw new Error(`扫描放不下 ${size.alongMm} × ${size.acrossMm} mm 区域，未缩小选区。请减小尺寸或检查转轴方向。`)
  }
  const cx = hingeAxis === 'y' && hingeCenterMm !== null ? hingeCenterMm : source.widthMm / 2
  const cy = hingeAxis === 'x' && hingeCenterMm !== null ? hingeCenterMm : source.lengthMm / 2
  const x: [number, number] = [cx - sx / 2, cx + sx / 2]
  const y: [number, number] = [cy - sy / 2, cy + sy / 2]
  if (x[0] < 0 || x[1] > source.widthMm || y[0] < 0 || y[1] > source.lengthMm) {
    throw new Error('转轴附近放不下完整区域，未偏移选区。请调整转轴位置或区域尺寸。')
  }
  // Use this data source's full Z range, not an earlier manual Z crop or repaired extrema.
  const bounds = { x, y, z: fullModelRegion(source).z }
  validateRegion(bounds)
  return bounds
}

export function assessmentSignature(version: string | undefined, bounds: RegionBounds | undefined,
  options: AssessmentOptions, source: 'current' | 'original'): string {
  return JSON.stringify({ version, bounds, options, source })
}
