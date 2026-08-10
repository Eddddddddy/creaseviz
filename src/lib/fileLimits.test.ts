import { describe, expect, it } from 'vitest'
import {
  FILE_LIMITS,
  assertCrc32,
  crc32,
  inspectStlHeader,
  validateCalibrationValue,
  validateCaptureCount,
  validatePaletteRange,
  validateZagDimensions,
  validateZipBudget,
} from './fileLimits'

function binaryStlHeader(triangles: number): Uint8Array {
  const header = new Uint8Array(84)
  new DataView(header.buffer).setUint32(80, triangles, true)
  return header
}

describe('ZAG resource limits', () => {
  it('accepts the calibrated dimensions used by a normal scan', () => {
    expect(validateZagDimensions(2773, 2053)).toMatchObject({
      pixels: 5_692_969,
      heightBytes: 22_771_876,
    })
    expect(() => validateCaptureCount(4)).not.toThrow()
  })

  it('rejects zero, oversized and excessive-pixel dimensions before allocation', () => {
    expect(() => validateZagDimensions(0, 2053)).toThrow(/必须大于 0/)
    expect(() => validateZagDimensions(FILE_LIMITS.zagDimension + 1, 1)).toThrow(/单边/)
    expect(() => validateZagDimensions(10_000, 10_000)).toThrow(/5000 万/)
  })

  it('rejects unknown ZIP sizes, zip bombs and excessive capture counts', () => {
    expect(() => validateZipBudget([{ name: 'field', directory: false }])).toThrow(/无法确认/)
    expect(() => validateZipBudget([{ name: 'bomb', directory: false, compressedSize: 1, uncompressedSize: 251 }]))
      .toThrow(/压缩比/)
    expect(() => validateCaptureCount(FILE_LIMITS.zagCaptureCount + 1)).toThrow(/超过安全上限/)
  })

  it('validates calibration and palette numbers', () => {
    expect(validateCalibrationValue(0.0074, 'XY')).toBe(0.0074)
    expect(() => validateCalibrationValue(Number.NaN, 'XY')).toThrow(/无效/)
    expect(() => validatePaletteRange(1, 1)).toThrow(/范围无效/)
  })
})

describe('STL resource limits', () => {
  it('accepts a real-sample-shaped binary header', () => {
    const triangles = 5_319_244
    expect(inspectStlHeader(84 + triangles * 50, binaryStlHeader(triangles))).toEqual({
      format: 'binary',
      triangleCount: triangles,
    })
  })

  it('rejects forged counts and truncated binary STL input', () => {
    expect(() => inspectStlHeader(84 + (FILE_LIMITS.stlTriangles + 1) * 50, binaryStlHeader(FILE_LIMITS.stlTriangles + 1)))
      .toThrow(/600 万/)
    expect(() => inspectStlHeader(1_000, binaryStlHeader(100))).toThrow(/文件长度不匹配/)
  })

  it('allows bounded ASCII STL only when the header identifies it', () => {
    expect(inspectStlHeader(128, new TextEncoder().encode('solid example'))).toEqual({ format: 'ascii' })
    expect(() => inspectStlHeader(128, new TextEncoder().encode('not-an-stl'))).toThrow(/文件长度不匹配/)
  })
})

describe('CRC32', () => {
  it('matches the standard check vector', () => {
    const bytes = new TextEncoder().encode('123456789')
    expect(crc32(bytes)).toBe(0xcbf43926)
    expect(() => assertCrc32(bytes, 0xcbf43926, 'valid')).not.toThrow()
    expect(() => assertCrc32(bytes, 0, 'tampered')).toThrow(/CRC 校验失败/)
  })
})
