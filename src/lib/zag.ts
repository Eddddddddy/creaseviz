import JSZip from 'jszip'
import type { CaptureSummary, ZagHeightField } from '../types'

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
  return Number(match[1])
}

function prefixedBmpUrl(bytes: ArrayBuffer): string | undefined {
  const view = new DataView(bytes)
  if (bytes.byteLength < 16 || view.getUint8(8) !== 0x42 || view.getUint8(9) !== 0x4d) return undefined
  const bmpLength = view.getUint32(10, true)
  if (bmpLength <= 0 || bmpLength + 8 > bytes.byteLength) return undefined
  return URL.createObjectURL(new Blob([bytes.slice(8, 8 + bmpLength)], { type: 'image/bmp' }))
}

export class ZagArchive {
  readonly fileName: string
  readonly captures: CaptureSummary[]
  readonly previewUrl?: string
  private readonly zip: JSZip

  private constructor(fileName: string, zip: JSZip, captures: CaptureSummary[], previewUrl?: string) {
    this.fileName = fileName
    this.zip = zip
    this.captures = captures
    this.previewUrl = previewUrl
  }

  static async open(file: File, onProgress?: (progress: number) => void): Promise<ZagArchive> {
    const bytes = await file.arrayBuffer()
    const previewUrl = prefixedBmpUrl(bytes)
    const zip = await JSZip.loadAsync(bytes, {
      checkCRC32: false,
    })
    onProgress?.(0.25)

    const suffix = `/${KEYS.captureName}/${VALUE}`
    const captureNamePaths = Object.keys(zip.files)
      .filter((path) => path.includes(`/${STORAGE}/`) && path.endsWith(suffix))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

    if (!captureNamePaths.length) throw new Error('没有在 ZAG 中找到 VR 高度采集记录')

    const captures: CaptureSummary[] = []
    for (let index = 0; index < captureNamePaths.length; index += 1) {
      const namePath = captureNamePaths[index]
      const basePath = namePath.slice(0, -suffix.length)
      const read = async (key: string) => {
        const entry = zip.file(`${basePath}/${key}/${VALUE}`)
        if (!entry) throw new Error(`ZAG 采集记录缺少字段 ${key}`)
        return entry.async('uint8array')
      }
      const [nameBytes, modelBytes, serialBytes, widthBytes, heightBytes, minBytes, maxBytes, calibrationBytes] =
        await Promise.all([
          read(KEYS.captureName),
          read(KEYS.model),
          read(KEYS.serial),
          read(KEYS.width),
          read(KEYS.height),
          read(KEYS.paletteMin),
          read(KEYS.paletteMax),
          read(KEYS.calibration),
        ])
      const calibration = decodeText(calibrationBytes)
      captures.push({
        id: basePath,
        name: decodeText(nameBytes),
        basePath,
        width: dataView(widthBytes).getUint32(0, true),
        height: dataView(heightBytes).getUint32(0, true),
        model: decodeText(modelBytes),
        serial: decodeText(serialBytes),
        xyPitchMm: extractNumber(calibration, 'MeterPerPixel') * 1000,
        zUnitMm: extractNumber(calibration, 'MeterPerUnit') * 1000,
        paletteMinMm: dataView(minBytes).getFloat64(0, true) * 1000,
        paletteMaxMm: dataView(maxBytes).getFloat64(0, true) * 1000,
      })
      onProgress?.(0.25 + ((index + 1) / captureNamePaths.length) * 0.25)
    }

    return new ZagArchive(file.name, zip, captures, previewUrl)
  }

  async loadCapture(capture: CaptureSummary, onProgress?: (progress: number) => void): Promise<ZagHeightField> {
    const read = async (key: string) => {
      const entry = this.zip.file(`${capture.basePath}/${key}/${VALUE}`)
      if (!entry) throw new Error(`ZAG 采集记录缺少字段 ${key}`)
      return entry.async('uint8array')
    }

    onProgress?.(0.52)
    const [heightBytes, mask, palette] = await Promise.all([
      read(KEYS.heightImage),
      read(KEYS.mask),
      read(KEYS.palette),
    ])
    onProgress?.(0.78)

    if (heightBytes.byteLength !== capture.width * capture.height * 4) {
      throw new Error('ZAG 高度矩阵尺寸与宽高字段不匹配')
    }
    const heights = new Int32Array(
      heightBytes.buffer.slice(heightBytes.byteOffset, heightBytes.byteOffset + heightBytes.byteLength),
    )
    const maskStride = Math.ceil(capture.width / 4) * 4
    if (mask.byteLength !== maskStride * capture.height) throw new Error('ZAG 掩码尺寸不匹配')

    return {
      capture,
      heights,
      mask,
      maskStride,
      palette,
    }
  }

  async loadTexture(capture: CaptureSummary): Promise<{ color: Uint8Array; colorStride: number }> {
    const entry = this.zip.file(`${capture.basePath}/${KEYS.color}/${VALUE}`)
    if (!entry) throw new Error('这条 ZAG 采集记录不包含表面纹理')
    const color = await entry.async('uint8array')
    const colorStride = Math.ceil((capture.width * 3) / 4) * 4
    if (color.byteLength !== colorStride * capture.height) throw new Error('ZAG 纹理尺寸不匹配')
    return { color, colorStride }
  }
}
