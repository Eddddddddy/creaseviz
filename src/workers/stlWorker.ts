/// <reference lib="webworker" />

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { FILE_LIMITS } from '../lib/fileLimits'
import { parseBinaryStl } from '../lib/stlBinary'

interface StlMessage {
  type: 'parse-stl'
  bytes: ArrayBuffer
  format: 'ascii' | 'binary'
  triangleCount?: number
}

interface ParsedStl {
  positions: Float32Array
  normals: Float32Array
  triangleCount: number
  originalPointCount: number
  sampleStep: number
  bounds?: [number, number, number, number, number, number]
}

function attributeToFloat32(attribute: { count: number; getX(index: number): number; getY(index: number): number; getZ(index: number): number }): Float32Array {
  const result = new Float32Array(attribute.count * 3)
  for (let index = 0; index < attribute.count; index += 1) {
    const offset = index * 3
    result[offset] = attribute.getX(index)
    result[offset + 1] = attribute.getY(index)
    result[offset + 2] = attribute.getZ(index)
  }
  return result
}

function parseAsciiStl(bytes: ArrayBuffer): ParsedStl {
  const geometry = new STLLoader().parse(bytes)
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  if (position.count === 0 || position.count % 3 !== 0) throw new Error('STL 不包含有效三角面')
  const triangleCount = position.count / 3
  if (triangleCount > FILE_LIMITS.stlTriangles) throw new Error('STL 三角面数量超过安全上限')
  return {
    positions: attributeToFloat32(position),
    normals: normal ? attributeToFloat32(normal) : new Float32Array(position.count * 3),
    triangleCount,
    originalPointCount: position.count,
    sampleStep: 1,
  }
}

self.onmessage = (event: MessageEvent<StlMessage>) => {
  if (event.data.type !== 'parse-stl') throw new Error('未知 STL Worker 消息')
  const parsed = event.data.format === 'binary'
    ? parseBinaryStl(event.data.bytes, event.data.triangleCount ?? 0)
    : parseAsciiStl(event.data.bytes)
  const { positions, normals } = parsed
  const pointCount = positions.length / 3
  if (pointCount === 0 || pointCount % 3 !== 0) throw new Error('STL 不包含有效三角面')

  let [minX, minY, minZ, maxX, maxY, maxZ] = parsed.bounds ?? [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]
  const sampleStride = Math.max(1, Math.floor(pointCount / 180_000))
  const values: number[] = []
  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 3
    const x = positions[offset]
    const y = positions[offset + 1]
    const z = positions[offset + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error('STL 坐标包含无效数值')
    }
    if (!parsed.bounds) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      minZ = Math.min(minZ, z)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      maxZ = Math.max(maxZ, z)
    }
    if (index % sampleStride === 0) values.push(z)
  }
  values.sort((a, b) => a - b)
  const percentile = (ratio: number) => values[Math.floor((values.length - 1) * ratio)] ?? 0

  const sectionBins = 500
  const sums = new Float64Array(sectionBins)
  const counts = new Uint32Array(sectionBins)
  const yMid = (minY + maxY) / 2
  const band = Math.max((maxY - minY) / 300, 0.002)
  const xRange = Math.max(1e-9, maxX - minX)
  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 3
    if (Math.abs(positions[offset + 1] - yMid) > band) continue
    const ratio = (positions[offset] - minX) / xRange
    const bin = Math.min(sectionBins - 1, Math.max(0, Math.floor(ratio * sectionBins)))
    sums[bin] += positions[offset + 2]
    counts[bin] += 1
  }
  const cross = new Float32Array(sectionBins)
  const crossX = new Float32Array(sectionBins)
  for (let index = 0; index < sectionBins; index += 1) {
    cross[index] = counts[index] ? sums[index] / counts[index] : Number.NaN
    crossX[index] = minX + ((index + 0.5) / sectionBins) * (maxX - minX)
  }

  const result = {
    type: 'stl-result',
    positions: positions.buffer,
    normals: normals.buffer,
    cross: cross.buffer,
    crossX: crossX.buffer,
    bounds: [minX, minY, minZ, maxX, maxY, maxZ],
    suggestedMinMm: percentile(0.01),
    suggestedMaxMm: percentile(0.99),
    triangleCount: parsed.triangleCount,
    originalPointCount: parsed.originalPointCount,
    renderedPointCount: pointCount,
    sampleStep: parsed.sampleStep,
  }
  self.postMessage(result, {
    transfer: [result.positions, result.normals, result.cross, result.crossX],
  })
}

export {}
