import type { RegionBounds, ViewerModel } from '../types'

export function fullModelRegion(model: Pick<ViewerModel, 'widthMm' | 'lengthMm' | 'minHeightMm' | 'maxHeightMm'>): RegionBounds {
  return {
    x: [0, Math.ceil(model.widthMm * 1e6) / 1e6],
    y: [0, Math.ceil(model.lengthMm * 1e6) / 1e6],
    z: [Math.floor(model.minHeightMm * 1e6) / 1e6 - 0.000001, Math.ceil(model.maxHeightMm * 1e6) / 1e6 + 0.000001],
  }
}

export interface RegionMesh {
  positions: Float32Array
  indices: Uint32Array
  uvs?: Float32Array
}

interface Vertex {
  values: number[]
  source: number
}

export function validateRegion(bounds: RegionBounds): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    const range = bounds[axis]
    if (!range || range.length !== 2 || !range.every(Number.isFinite) || range[0] >= range[1]) {
      throw new Error(`${axis.toUpperCase()} 选区范围无效，最小值必须小于最大值`)
    }
  }
}

/** Clip crossing triangles at all six boundaries, interpolating UVs at new vertices. */
export function clipMeshToRegion(mesh: RegionMesh, bounds: RegionBounds, maxVertices = 1_000_000): RegionMesh {
  validateRegion(bounds)
  // Mesh coordinates use Y for measured height and Z for scan length.
  const planes = [
    [0, bounds.x[0], 1], [0, bounds.x[1], -1],
    [2, bounds.y[0], 1], [2, bounds.y[1], -1],
    [1, bounds.z[0], 1], [1, bounds.z[1], -1],
  ]
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const remapped = new Int32Array(mesh.positions.length / 3).fill(-1)
  const boundaryVertices = new Map<string, number>()
  const read = (index: number): Vertex => ({
    values: [
      mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2],
      mesh.uvs?.[index * 2] ?? 0, mesh.uvs?.[index * 2 + 1] ?? 0,
    ],
    source: index,
  })
  const write = (vertex: Vertex): number => {
    const existing = vertex.source >= 0 ? remapped[vertex.source] : undefined
    if (existing !== undefined && existing >= 0) return existing
    const key = vertex.source < 0 ? vertex.values.map((value) => value.toPrecision(12)).join(',') : undefined
    if (key !== undefined) {
      const shared = boundaryVertices.get(key)
      if (shared !== undefined) return shared
    }
    const index = positions.length / 3
    if (index >= maxVertices) throw new Error('选区网格超过 100 万点，请缩小选区或降低导出精度')
    positions.push(vertex.values[0], vertex.values[1], vertex.values[2])
    if (mesh.uvs) uvs.push(vertex.values[3], vertex.values[4])
    if (vertex.source >= 0) remapped[vertex.source] = index
    else if (key !== undefined) boundaryVertices.set(key, index)
    return index
  }

  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    let polygon = [read(mesh.indices[offset]), read(mesh.indices[offset + 1]), read(mesh.indices[offset + 2])]
    for (const [axis, limit, direction] of planes) {
      if (!polygon.length) break
      if (polygon.every((vertex) => (vertex.values[axis] - limit) * direction >= 0)) continue
      const clipped: Vertex[] = []
      let previous = polygon[polygon.length - 1]
      let previousDistance = (previous.values[axis] - limit) * direction
      for (const current of polygon) {
        const distance = (current.values[axis] - limit) * direction
        if ((distance >= 0) !== (previousDistance >= 0)) {
          const t = previousDistance / (previousDistance - distance)
          const values = previous.values.map((value, index) => value + t * (current.values[index] - value))
          values[axis] = limit
          clipped.push({ values, source: -1 })
        }
        if (distance >= 0) clipped.push(current)
        previous = current
        previousDistance = distance
      }
      polygon = clipped
    }
    for (let corner = 1; corner + 1 < polygon.length; corner += 1) {
      const a = polygon[0].values
      const b = polygon[corner].values
      const c = polygon[corner + 1].values
      const cross = [
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
      ]
      if (cross.every((value) => value === 0)) continue
      indices.push(write(polygon[0]), write(polygon[corner]), write(polygon[corner + 1]))
    }
  }
  if (!indices.length) throw new Error('选区内没有有效表面，请调整 X、Y 或 Z 范围')
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    uvs: mesh.uvs ? new Float32Array(uvs) : undefined,
  }
}
