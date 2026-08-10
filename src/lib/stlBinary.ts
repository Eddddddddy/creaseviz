import { FILE_LIMITS } from './fileLimits'

export interface ParsedBinaryStl {
  positions: Float32Array
  normals: Float32Array
  triangleCount: number
  originalPointCount: number
  sampleStep: number
  bounds: [number, number, number, number, number, number]
}

export function parseBinaryStl(
  bytes: ArrayBuffer,
  triangleCount: number,
  targetRenderedTriangles = 600_000,
): ParsedBinaryStl {
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 1 || triangleCount > FILE_LIMITS.stlTriangles) {
    throw new Error('二进制 STL 三角面数量无效')
  }
  if (!Number.isSafeInteger(targetRenderedTriangles) || targetRenderedTriangles < 1) {
    throw new Error('STL 目标显示面数无效')
  }
  if (bytes.byteLength !== 84 + triangleCount * 50) throw new Error('二进制 STL 长度与三角面数量不匹配')
  const sampleStep = Math.max(1, Math.ceil(triangleCount / targetRenderedTriangles))
  const renderedTriangles = Math.ceil(triangleCount / sampleStep)
  const positions = new Float32Array(renderedTriangles * 9)
  const normals = new Float32Array(renderedTriangles * 9)
  const view = new DataView(bytes)
  let output = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let face = 0; face < triangleCount; face += 1) {
    const record = 84 + face * 50
    const sampled = face % sampleStep === 0
    const normalX = view.getFloat32(record, true)
    const normalY = view.getFloat32(record + 4, true)
    const normalZ = view.getFloat32(record + 8, true)
    if (!Number.isFinite(normalX) || !Number.isFinite(normalY) || !Number.isFinite(normalZ)) {
      throw new Error('STL 法向量包含无效数值')
    }
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const source = record + 12 + vertex * 12
      const x = view.getFloat32(source, true)
      const y = view.getFloat32(source + 4, true)
      const z = view.getFloat32(source + 8, true)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error('STL 坐标包含无效数值')
      }
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      minZ = Math.min(minZ, z)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      maxZ = Math.max(maxZ, z)
      if (sampled) {
        positions[output] = x
        positions[output + 1] = y
        positions[output + 2] = z
        normals[output] = normalX
        normals[output + 1] = normalY
        normals[output + 2] = normalZ
        output += 3
      }
    }
  }
  return {
    positions,
    normals,
    triangleCount,
    originalPointCount: triangleCount * 3,
    sampleStep,
    bounds: [minX, minY, minZ, maxX, maxY, maxZ],
  }
}
