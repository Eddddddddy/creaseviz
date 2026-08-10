import { describe, expect, it } from 'vitest'
import { createObjBlob, safeObjFileName, safeObjName } from './objExport'

describe('OBJ export', () => {
  it('maps ZAG viewer axes to measurement XYZ and preserves face winding', async () => {
    const { blob, summary } = createObjBlob({
      name: 'scan.zag',
      positions: new Float32Array([
        0, 0.1, 0,
        1, 0.2, 0,
        0, 0.3, 2,
      ]),
      indices: new Uint32Array([0, 2, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      scaleMode: 'true',
    })
    const text = await blob.text()

    expect(text).toContain('# Units: millimeters')
    expect(text).toContain('# Axes: X = scan width, Y = scan length, Z = measured height')
    expect(text).toContain('v 0 0 0.1')
    expect(text).toContain('v 0 2 0.3')
    expect(text).toContain('f 1/1 2/2 3/3')
    expect(summary).toMatchObject({ vertexCount: 3, triangleCount: 1 })
  })

  it('applies display scale independently on measurement axes', async () => {
    const { blob } = createObjBlob({
      name: 'scaled',
      positions: new Float32Array([1, 3, 2, 0, 0, 0, 1, 0, 0]),
      scaleX: 2,
      scaleY: 4,
      scaleZ: 10,
      scaleMode: 'display',
    })
    expect(await blob.text()).toContain('v 2 8 30')
  })

  it('sanitizes names and rejects malformed geometry', () => {
    expect(safeObjName('../VR scan\nname.zag')).toBe('VR-scan-name')
    expect(safeObjFileName('fold scan.zag', 'true')).toBe('fold-scan-true-scale.obj')
    expect(() => createObjBlob({
      name: 'invalid',
      positions: new Float32Array([0, 0]),
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      scaleMode: 'true',
    })).toThrow(/顶点缓冲区/)
  })
})
