import type { RegionBounds } from '../types'

export type ObjScaleMode = 'true' | 'display'

export const OBJ_LIMITS = {
  maxVertices: 1_000_000,
  maxTriangles: 2_000_000,
  workerTimeoutMs: 60_000,
  linesPerChunk: 4_096,
} as const

export interface ObjMeshInput {
  name: string
  positions: Float32Array
  indices?: Uint32Array
  uvs?: Float32Array
  scaleX: number
  scaleY: number
  scaleZ: number
  scaleMode: ObjScaleMode
  region?: RegionBounds
  sampleStep?: number
  spikeRepair?: { thresholdUm: number; radiusMm: number; direction: string; changedCount: number }
}

export interface ObjMeshSummary {
  vertexCount: number
  triangleCount: number
  size: number
  sampleStep?: number
}

function requireScale(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error(`${label} 导出比例无效`)
}

function objNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('OBJ 顶点包含无效数值')
  const normalized = Math.abs(value) < 0.0000005 ? 0 : value
  return normalized.toFixed(6).replace(/\.?0+$/, '')
}

function clampBoundary(value: number, range?: [number, number]): number {
  return range ? Math.max(range[0], Math.min(range[1], value)) : value
}

export function safeObjName(value: string): string {
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
  return withoutControls
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'crease-scan'
}

export function safeObjFileName(value: string, scaleMode: ObjScaleMode): string {
  return `${safeObjName(value)}-${scaleMode === 'true' ? 'true-scale' : 'display-scale'}.obj`
}

export function createObjBlob(
  input: ObjMeshInput,
  onProgress?: (progress: number) => void,
): { blob: Blob; summary: ObjMeshSummary } {
  if (input.positions.length === 0 || input.positions.length % 3 !== 0) {
    throw new Error('OBJ 顶点缓冲区尺寸无效')
  }
  const vertexCount = input.positions.length / 3
  if (vertexCount > OBJ_LIMITS.maxVertices) throw new Error('OBJ 顶点数量超过安全上限')
  if (input.uvs && input.uvs.length !== vertexCount * 2) throw new Error('OBJ UV 缓冲区尺寸无效')
  if (input.indices && (input.indices.length === 0 || input.indices.length % 3 !== 0)) {
    throw new Error('OBJ 三角面索引尺寸无效')
  }
  if (!input.indices && vertexCount % 3 !== 0) throw new Error('非索引 OBJ 网格无法组成完整三角面')

  const triangleCount = input.indices ? input.indices.length / 3 : vertexCount / 3
  if (triangleCount > OBJ_LIMITS.maxTriangles) throw new Error('OBJ 三角面数量超过安全上限')
  requireScale(input.scaleX, 'X')
  requireScale(input.scaleY, 'Y')
  requireScale(input.scaleZ, 'Z')

  const objectName = safeObjName(input.name)
  const scaleDescription = input.scaleMode === 'true'
    ? 'true measurement scale (1:1:1)'
    : `display scale (${input.scaleX}:${input.scaleY}:${input.scaleZ})`
  const parts: BlobPart[] = [
    '# CreaseViz ZAG to OBJ export\n',
    '# Units: millimeters\n',
    '# Axes: X = scan width, Y = scan length, Z = measured height\n',
    `# Scale: ${scaleDescription}\n`,
    ...(input.region ? [`# Region (mm, before scale): X ${input.region.x.join('..')}; Y ${input.region.y.join('..')}; Z ${input.region.z.join('..')}\n`] : []),
    ...(input.sampleStep ? [`# Source sample step: ${input.sampleStep} pixel(s)\n`] : []),
    ...(input.spikeRepair ? [`# Processing: isolated spike repair; threshold ${input.spikeRepair.thresholdUm} um; radius ${input.spikeRepair.radiusMm} mm; direction ${input.spikeRepair.direction}; changed ${input.spikeRepair.changedCount} points\n`] : []),
    `# Vertices: ${vertexCount}; Triangles: ${triangleCount}\n`,
    `o ${objectName}\n`,
  ]
  const lines: string[] = []
  const totalOperations = vertexCount + (input.uvs ? vertexCount : 0) + triangleCount
  let completedOperations = 0

  const flush = () => {
    if (!lines.length) return
    parts.push(`${lines.join('\n')}\n`)
    lines.length = 0
    onProgress?.(Math.min(1, completedOperations / Math.max(1, totalOperations)))
  }

  for (let index = 0; index < vertexCount; index += 1) {
    const offset = index * 3
    // Viewer coordinates are X=width, Y=height, Z=scan length. OBJ is exported
    // in measurement coordinates so downstream tools see Z as the height axis.
    const x = clampBoundary(input.positions[offset], input.region?.x) * input.scaleX
    const y = clampBoundary(input.positions[offset + 2], input.region?.y) * input.scaleY
    const z = clampBoundary(input.positions[offset + 1], input.region?.z) * input.scaleZ
    lines.push(`v ${objNumber(x)} ${objNumber(y)} ${objNumber(z)}`)
    completedOperations += 1
    if (lines.length >= OBJ_LIMITS.linesPerChunk) flush()
  }
  flush()

  if (input.uvs) {
    for (let index = 0; index < vertexCount; index += 1) {
      const offset = index * 2
      lines.push(`vt ${objNumber(input.uvs[offset])} ${objNumber(input.uvs[offset + 1])}`)
      completedOperations += 1
      if (lines.length >= OBJ_LIMITS.linesPerChunk) flush()
    }
    flush()
  }

  parts.push('s 1\n')
  const faceVertex = (index: number): string => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= vertexCount) throw new Error('OBJ 三角面索引越界')
    const oneBased = index + 1
    return input.uvs ? `${oneBased}/${oneBased}` : String(oneBased)
  }
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3
    const a = input.indices ? input.indices[offset] : offset
    const b = input.indices ? input.indices[offset + 1] : offset + 1
    const c = input.indices ? input.indices[offset + 2] : offset + 2
    // Swapping the viewer's Y/Z axes changes handedness, so reverse each face
    // to preserve the upward-facing winding in measurement coordinates.
    lines.push(`f ${faceVertex(a)} ${faceVertex(c)} ${faceVertex(b)}`)
    completedOperations += 1
    if (lines.length >= OBJ_LIMITS.linesPerChunk) flush()
  }
  flush()
  onProgress?.(1)

  const blob = new Blob(parts, { type: 'text/plain;charset=utf-8' })
  return { blob, summary: { vertexCount, triangleCount, size: blob.size, sampleStep: input.sampleStep } }
}
