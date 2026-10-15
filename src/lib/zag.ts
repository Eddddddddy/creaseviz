import type { CaptureSummary, ZagHeightField } from '../types'
import { FileZipArchive } from './fileZip'
import {
  FILE_LIMITS,
  assertCrc32,
  assertNotAborted,
  validateCalibrationValue,
  validateCaptureCount,
  validatePaletteRange,
  validateZagDimensions,
  validateZagFileSize,
} from './fileLimits'

const STORAGE = '9eedddb6-0cf2-4021-9ffc-4e46618e365b'
const VALUE = 'e57e75b1-707b-4a6f-a095-1485b8b95efb'

const KEYS = {
  captureName: '1dd7dd49-2b97-4bb7-bc2f-d3d017ec6473',
  model: '8eaa0dd8-c7ef-4f49-b466-d64ffefabaa1',
  serial: '95492a0e-2333-4082-9700-573dff66f42a',
  width: '6e2be320-a58e-401d-bc0f-f4d3706014f5',
  height: '5130c3fd-6e9d-4617-9701-d7cef74e4932',
  imageStride: 'f14ad4d3-4f17-4912-a180-1bafbcf38900',
  heightImage: '4d137b4a-bf22-49d5-96a8-9b07b3fc5d02',
  mask: '2c7fd1a8-b42a-41ff-9baa-56760304e826',
  color: '4a559e92-2e29-47db-989d-9684a7fd0b38',
  palette: 'ad3d63d2-2381-45d4-b68d-07d6bb540d5d',
  paletteMin: '636b3524-4d02-423f-a801-7a90e14df721',
  paletteMax: '71c0b18d-ee9c-4216-a26a-e1ba1dd286b9',
  calibration: '584a57f1-1403-48ef-a465-91ec66c829f7',
} as const

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
}

function extractNumber(xml: string, tag: string): number {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))
  if (!match) throw new Error(`ZAG 中缺少 ${tag} 标定字段`)
  return validateCalibrationValue(Number(match[1]) * 1000, `${tag} `)
}

export class ZagArchive {
  readonly fileName: string
  readonly captures: CaptureSummary[]
  private readonly zip: FileZipArchive

  private constructor(file: File, captures: CaptureSummary[], zip: FileZipArchive) {
    this.fileName = file.name
    this.captures = captures
    this.zip = zip
  }

  private static async loadZip(file: File, signal?: AbortSignal): Promise<FileZipArchive> {
    validateZagFileSize(file.size)
    assertNotAborted(signal)
    return FileZipArchive.open(file, signal)
  }

  private async takeZip(signal?: AbortSignal): Promise<FileZipArchive> {
    assertNotAborted(signal)
    return this.zip
  }

  static async open(
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<ZagArchive> {
    const zip = await ZagArchive.loadZip(file, signal)
    onProgress?.(0.25)

    const suffix = `/${KEYS.captureName}/${VALUE}`
    const captureNamePaths = Object.keys(zip.files)
      .filter((path) => path.includes(`/${STORAGE}/`) && path.endsWith(suffix))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

    validateCaptureCount(captureNamePaths.length)

    const captures: CaptureSummary[] = []
    for (let index = 0; index < captureNamePaths.length; index += 1) {
      assertNotAborted(signal)
      const namePath = captureNamePaths[index]
      const basePath = namePath.slice(0, -suffix.length)
      const [nameBytes, modelBytes, serialBytes, widthBytes, heightBytes, minBytes, maxBytes, calibrationBytes] =
        await Promise.all([
          ZagArchive.readZipEntry(zip, `${basePath}/${KEYS.captureName}/${VALUE}`, 4_096, undefined, signal),
          zip.file(`${basePath}/${KEYS.model}/${VALUE}`)
            ? ZagArchive.readZipEntry(zip, `${basePath}/${KEYS.model}/${VALUE}`, 4_096, undefined, signal)
            : Promise.resolve(new Uint8Array()),
          zip.file(`${basePath}/${KEYS.serial}/${VALUE}`)
            ? ZagArchive.readZipEntry(zip, `${basePath}/${KEYS.serial}/${VALUE}`, 4_096, undefined, signal)
            : Promise.resolve(new Uint8Array()),
          ZagArchive.readZipEntry(zip, `${basePath}/${KEYS.width}/${VALUE}`, 4, 4, signal),
          ZagArchive.readZipEntry(zip, `${basePath}/${KEYS.height}/${VALUE}`, 4, 4, signal),
          zip.file(`${basePath}/${KEYS.paletteMin}/${VALUE}`)
            ? ZagArchive.readZipEntry(zip, `${basePath}/${KEYS.paletteMin}/${VALUE}`, 8, 8, signal)
            : Promise.resolve(new Uint8Array()),
          zip.file(`${basePath}/${KEYS.paletteMax}/${VALUE}`)
            ? ZagArchive.readZipEntry(zip, `${basePath}/${KEYS.paletteMax}/${VALUE}`, 8, 8, signal)
            : Promise.resolve(new Uint8Array()),
          ZagArchive.readZipEntry(
            zip,
            `${basePath}/${KEYS.calibration}/${VALUE}`,
            FILE_LIMITS.zagMetadataBytes,
            undefined,
            signal,
          ),
        ])
      const calibration = decodeText(calibrationBytes)
      const width = dataView(widthBytes).getUint32(0, true)
      const height = dataView(heightBytes).getUint32(0, true)
      validateZagDimensions(width, height)
      const paletteMinMm = minBytes.byteLength ? dataView(minBytes).getFloat64(0, true) * 1000 : undefined
      const paletteMaxMm = maxBytes.byteLength ? dataView(maxBytes).getFloat64(0, true) * 1000 : undefined
      if (paletteMinMm !== undefined && paletteMaxMm !== undefined) validatePaletteRange(paletteMinMm, paletteMaxMm)
      captures.push({
        id: basePath,
        name: decodeText(nameBytes),
        basePath,
        width,
        height,
        model: decodeText(modelBytes) || '未记录',
        serial: decodeText(serialBytes) || '未记录',
        xyPitchMm: extractNumber(calibration, 'MeterPerPixel'),
        zUnitMm: extractNumber(calibration, 'MeterPerUnit'),
        paletteMinMm,
        paletteMaxMm,
      })
      onProgress?.(0.25 + ((index + 1) / captureNamePaths.length) * 0.25)
    }

    return new ZagArchive(file, captures, zip)
  }

  private static async readZipEntry(
    zip: FileZipArchive,
    path: string,
    maxBytes: number,
    expectedBytes?: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    assertNotAborted(signal)
    const entry = zip.file(path)
    if (!entry) throw new Error(`ZAG 采集记录缺少字段 ${path.split('/').at(-2) ?? path}`)
    const data = entry.data
    if (data.uncompressedSize > maxBytes) throw new Error(`ZAG 条目超过允许大小：${entry.name}`)
    if (expectedBytes !== undefined && data.uncompressedSize !== expectedBytes) {
      throw new Error(`ZAG 条目尺寸不匹配：${entry.name}`)
    }
    const bytes = await entry.read()
    assertNotAborted(signal)
    if (bytes.byteLength !== data.uncompressedSize || bytes.byteLength > maxBytes) {
      throw new Error(`ZAG 条目解压尺寸不匹配：${entry.name}`)
    }
    assertCrc32(bytes, data.crc32, entry.name)
    return bytes
  }

  async loadCapture(
    capture: CaptureSummary,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<ZagHeightField> {
    const dimensions = validateZagDimensions(capture.width, capture.height)
    const zip = await this.takeZip(signal)

    onProgress?.(0.52)
    const colorPath = `${capture.basePath}/${KEYS.color}/${VALUE}`
    const [heightBytes, mask, palette, color] = await Promise.all([
      ZagArchive.readZipEntry(
        zip,
        `${capture.basePath}/${KEYS.heightImage}/${VALUE}`,
        dimensions.heightBytes,
        dimensions.heightBytes,
        signal,
      ),
      ZagArchive.readZipEntry(
        zip,
        `${capture.basePath}/${KEYS.mask}/${VALUE}`,
        dimensions.maskBytes,
        dimensions.maskBytes,
        signal,
      ),
      ZagArchive.readZipEntry(
        zip,
        `${capture.basePath}/${KEYS.palette}/${VALUE}`,
        FILE_LIMITS.zagPaletteBytes,
        undefined,
        signal,
      ),
      zip.file(colorPath)
        ? ZagArchive.readZipEntry(zip, colorPath, dimensions.colorBytes, dimensions.colorBytes, signal)
        : Promise.resolve(undefined),
    ])
    onProgress?.(0.78)

    const heights = new Int32Array(
      heightBytes.buffer.slice(heightBytes.byteOffset, heightBytes.byteOffset + heightBytes.byteLength),
    )

    return {
      capture,
      heights,
      mask,
      maskStride: dimensions.maskStride,
      palette,
      color,
      colorStride: color ? dimensions.colorStride : undefined,
    }
  }

  async loadTexture(
    capture: CaptureSummary,
    signal?: AbortSignal,
  ): Promise<{ color: Uint8Array; colorStride: number }> {
    const dimensions = validateZagDimensions(capture.width, capture.height)
    const zip = await this.takeZip(signal)
    const color = await ZagArchive.readZipEntry(
      zip,
      `${capture.basePath}/${KEYS.color}/${VALUE}`,
      dimensions.colorBytes,
      dimensions.colorBytes,
      signal,
    ).catch((cause) => {
      if (cause instanceof Error && cause.message.includes('缺少字段')) {
        throw new Error('这条 ZAG 采集记录不包含表面纹理')
      }
      throw cause
    })
    return { color, colorStride: dimensions.colorStride }
  }
}
