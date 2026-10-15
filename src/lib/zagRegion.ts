import type { CaptureSummary, ObjDetail, RegionBounds } from '../types'
import { validateCalibrationValue, validateZagDimensions } from './fileLimits'
import { OBJ_LIMITS } from './objExport'
import { clipMeshToRegion, validateRegion, type RegionMesh } from './region'

export interface ZagRegionSource {
  heights: Int32Array
  mask: Uint8Array
  maskStride: number
  capture: Pick<CaptureSummary, 'width' | 'height' | 'xyPitchMm' | 'zUnitMm'>
}

export function buildZagRegionMesh(
  source: ZagRegionSource,
  bounds: RegionBounds,
  detail: ObjDetail,
  onProgress?: (progress: number) => void,
): RegionMesh & { sampleStep: number } {
  validateRegion(bounds)
  const { width, height, xyPitchMm, zUnitMm } = source.capture
  const dimensions = validateZagDimensions(width, height)
  validateCalibrationValue(xyPitchMm, 'XY ')
  validateCalibrationValue(zUnitMm, 'Z ')
  if (source.heights.length !== dimensions.pixels || source.maskStride !== dimensions.maskStride
    || source.mask.length !== dimensions.maskBytes) throw new Error('原始高度数据尺寸不匹配')
  if (!['preview', 'high', 'original'].includes(detail)) throw new Error('OBJ 导出精度无效')

  const startX = Math.max(0, Math.floor(bounds.x[0] / xyPitchMm))
  const endX = Math.min(width - 1, Math.ceil(bounds.x[1] / xyPitchMm))
  const startY = Math.max(0, Math.floor(bounds.y[0] / xyPitchMm))
  const endY = Math.min(height - 1, Math.ceil(bounds.y[1] / xyPitchMm))
  if (startX >= endX || startY >= endY) throw new Error('选区内没有有效表面，请扩大 X/Y 范围')
  const count = (endX - startX + 1) * (endY - startY + 1)
  if (detail === 'original' && count > OBJ_LIMITS.maxVertices - 20_000) {
    throw new Error(`选区约 ${count.toLocaleString()} 个原始点，超过原始采样导出上限；请缩小选区或选择高精度`)
  }
  const target = detail === 'preview' ? 200_000 : 800_000
  let sampleStep = detail === 'original' ? 1 : Math.max(1, Math.ceil(Math.sqrt(count / target)))
  const samples = (start: number, end: number): number[] => {
    const values: number[] = []
    for (let index = start; index < end; index += sampleStep) values.push(index)
    values.push(end)
    return values
  }
  let columns = samples(startX, endX)
  let rows = samples(startY, endY)
  while (detail !== 'original' && columns.length * rows.length > target) {
    sampleStep += 1
    columns = samples(startX, endX)
    rows = samples(startY, endY)
  }
  const vertexCount = columns.length * rows.length
  const positions = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const valid = new Uint8Array(vertexCount)
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < columns.length; column += 1) {
      const index = row * columns.length + column
      positions[index * 3] = columns[column] * xyPitchMm
      positions[index * 3 + 1] = source.heights[rows[row] * width + columns[column]] * zUnitMm
      positions[index * 3 + 2] = rows[row] * xyPitchMm
      uvs[index * 2] = columns[column] / Math.max(1, width - 1)
      uvs[index * 2 + 1] = 1 - rows[row] / Math.max(1, height - 1)
      valid[index] = source.mask[rows[row] * source.maskStride + columns[column]] !== 2 ? 1 : 0
    }
  }
  onProgress?.(0.3)
  const indices: number[] = []
  for (let row = 0; row + 1 < rows.length; row += 1) {
    for (let column = 0; column + 1 < columns.length; column += 1) {
      const a = row * columns.length + column
      const b = a + 1
      const c = a + columns.length
      const d = c + 1
      if (valid[a] && valid[b] && valid[c]) indices.push(a, c, b)
      if (valid[b] && valid[c] && valid[d]) indices.push(b, c, d)
    }
  }
  const result = clipMeshToRegion({ positions, indices: new Uint32Array(indices), uvs }, bounds)
  onProgress?.(1)
  return { ...result, sampleStep }
}
