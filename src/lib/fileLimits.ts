export const FILE_LIMITS = {
  zagFileBytes: 512 * 1024 * 1024,
  zagEntryCount: 4_096,
  zagUncompressedBytes: 1024 * 1024 * 1024,
  zagCompressionRatio: 250,
  zagCaptureCount: 64,
  zagDimension: 16_384,
  zagPixels: 50_000_000,
  zagMetadataBytes: 64 * 1024,
  zagPaletteBytes: 1024 * 1024,
  stlFileBytes: 384 * 1024 * 1024,
  stlAsciiBytes: 64 * 1024 * 1024,
  stlTriangles: 6_000_000,
  workerTimeoutMs: 45_000,
} as const

export interface ZipEntryBudget {
  name: string
  directory: boolean
  compressedSize?: number
  uncompressedSize?: number
}

export interface ZagDimensions {
  pixels: number
  heightBytes: number
  maskStride: number
  maskBytes: number
  colorStride: number
  colorBytes: number
}

export interface StlInspection {
  format: 'ascii' | 'binary'
  triangleCount?: number
}

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}不是安全的非负整数`)
}

export function checkedProduct(values: number[], label: string): number {
  let result = 1
  for (const value of values) {
    requireSafeInteger(value, label)
    result *= value
    if (!Number.isSafeInteger(result)) throw new Error(`${label}超出安全整数范围`)
  }
  return result
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('文件加载已取消', 'AbortError')
}

export function validateZagFileSize(size: number): void {
  requireSafeInteger(size, 'ZAG 文件大小')
  if (size === 0) throw new Error('ZAG 文件为空')
  if (size > FILE_LIMITS.zagFileBytes) throw new Error('ZAG 文件超过 512 MiB 安全上限')
}

export function validateZipBudget(entries: ZipEntryBudget[]): void {
  if (entries.length > FILE_LIMITS.zagEntryCount) throw new Error('ZAG 条目数量超过安全上限')
  let totalUncompressed = 0
  for (const entry of entries) {
    if (entry.directory) continue
    const { compressedSize, uncompressedSize } = entry
    if (compressedSize === undefined || uncompressedSize === undefined) {
      throw new Error(`无法确认 ZAG 条目大小：${entry.name}`)
    }
    requireSafeInteger(compressedSize, 'ZAG 压缩条目大小')
    requireSafeInteger(uncompressedSize, 'ZAG 解压条目大小')
    totalUncompressed += uncompressedSize
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > FILE_LIMITS.zagUncompressedBytes) {
      throw new Error('ZAG 解压后总大小超过 1 GiB 安全上限')
    }
    if (uncompressedSize > 0) {
      if (compressedSize === 0 || uncompressedSize / compressedSize > FILE_LIMITS.zagCompressionRatio) {
        throw new Error(`ZAG 条目压缩比异常：${entry.name}`)
      }
    }
  }
}

export function validateCaptureCount(count: number): void {
  requireSafeInteger(count, 'ZAG 采集记录数量')
  if (count === 0) throw new Error('没有在 ZAG 中找到 VR 高度采集记录')
  if (count > FILE_LIMITS.zagCaptureCount) throw new Error('ZAG 采集记录数量超过安全上限')
}

export function validateZagDimensions(width: number, height: number): ZagDimensions {
  requireSafeInteger(width, 'ZAG 宽度')
  requireSafeInteger(height, 'ZAG 高度')
  if (width === 0 || height === 0) throw new Error('ZAG 宽高必须大于 0')
  if (width > FILE_LIMITS.zagDimension || height > FILE_LIMITS.zagDimension) {
    throw new Error('ZAG 单边像素尺寸超过安全上限')
  }
  const pixels = checkedProduct([width, height], 'ZAG 像素总数')
  if (pixels > FILE_LIMITS.zagPixels) throw new Error('ZAG 像素总数超过 5000 万安全上限')
  const maskStride = Math.ceil(width / 4) * 4
  const colorStride = Math.ceil((width * 3) / 4) * 4
  return {
    pixels,
    heightBytes: checkedProduct([pixels, 4], 'ZAG 高度矩阵大小'),
    maskStride,
    maskBytes: checkedProduct([maskStride, height], 'ZAG 掩码大小'),
    colorStride,
    colorBytes: checkedProduct([colorStride, height], 'ZAG 纹理大小'),
  }
}

export function validateCalibrationValue(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error(`${label}标定值无效`)
  return value
}

export function validatePaletteRange(minimum: number, maximum: number): void {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) {
    throw new Error('ZAG 高度色范围无效')
  }
}

function beginsWithAsciiSolid(header: Uint8Array): boolean {
  const prefix = new TextDecoder('ascii').decode(header.slice(0, 80)).trimStart().slice(0, 5).toLowerCase()
  return prefix === 'solid'
}

export function inspectStlHeader(fileSize: number, header: Uint8Array): StlInspection {
  requireSafeInteger(fileSize, 'STL 文件大小')
  if (fileSize === 0) throw new Error('STL 文件为空')
  if (fileSize > FILE_LIMITS.stlFileBytes) throw new Error('STL 文件超过 384 MiB 安全上限')

  if (header.byteLength >= 84) {
    const triangleCount = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(80, true)
    const expectedSize = 84 + triangleCount * 50
    if (Number.isSafeInteger(expectedSize) && expectedSize === fileSize) {
      if (triangleCount === 0) throw new Error('二进制 STL 不包含三角面')
      if (triangleCount > FILE_LIMITS.stlTriangles) throw new Error('STL 三角面数量超过 600 万安全上限')
      return { format: 'binary', triangleCount }
    }
  }

  if (!beginsWithAsciiSolid(header)) throw new Error('STL 头部面数与文件长度不匹配')
  if (fileSize > FILE_LIMITS.stlAsciiBytes) throw new Error('ASCII STL 超过 64 MiB 安全上限')
  return { format: 'ascii' }
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

export function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff
  for (const byte of bytes) checksum = CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8)
  return (checksum ^ 0xffffffff) >>> 0
}

export function assertCrc32(bytes: Uint8Array, expected: number, label: string): void {
  if (!Number.isInteger(expected) || crc32(bytes) !== (expected >>> 0)) {
    throw new Error(`ZAG 条目 CRC 校验失败：${label}`)
  }
}
