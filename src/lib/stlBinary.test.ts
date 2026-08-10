import { describe, expect, it } from 'vitest'
import { parseBinaryStl } from './stlBinary'

function binaryStl(faces: Array<Array<[number, number, number]>>): ArrayBuffer {
  const bytes = new ArrayBuffer(84 + faces.length * 50)
  const view = new DataView(bytes)
  view.setUint32(80, faces.length, true)
  faces.forEach((vertices, face) => {
    const record = 84 + face * 50
    view.setFloat32(record + 8, 1, true)
    vertices.forEach(([x, y, z], vertex) => {
      const offset = record + 12 + vertex * 12
      view.setFloat32(offset, x, true)
      view.setFloat32(offset + 4, y, true)
      view.setFloat32(offset + 8, z, true)
    })
  })
  return bytes
}

describe('binary STL parser', () => {
  it('downsamples displayed triangles while preserving full-file bounds', () => {
    const bytes = binaryStl([
      [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[100, 0, -5], [101, 0, -5], [100, 1, -5]],
      [[2, 0, 1], [3, 0, 1], [2, 1, 1]],
      [[4, 0, 2], [5, 0, 2], [4, 1, 2]],
    ])
    const parsed = parseBinaryStl(bytes, 4, 2)
    expect(parsed.sampleStep).toBe(2)
    expect(parsed.positions).toHaveLength(18)
    expect(parsed.bounds).toEqual([0, 0, -5, 101, 1, 2])
    expect(parsed.originalPointCount).toBe(12)
  })

  it('rejects invalid coordinates and inconsistent lengths', () => {
    const invalid = binaryStl([[[0, 0, 0], [1, 0, 0], [0, 1, Number.NaN]]])
    expect(() => parseBinaryStl(invalid, 1)).toThrow(/无效数值/)
    const invalidNormal = binaryStl([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]])
    new DataView(invalidNormal).setFloat32(84, Number.NaN, true)
    expect(() => parseBinaryStl(invalidNormal, 1)).toThrow(/法向量/)
    expect(() => parseBinaryStl(new ArrayBuffer(84), 1)).toThrow(/长度/)
  })
})
