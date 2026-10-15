import { expect, it } from 'vitest'
import JSZip from 'jszip'
import { FileZipArchive } from './fileZip'

class TrackingFile extends File {
  slicedBytes = 0
  override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('Must not read the entire project') }
  override slice(start?: number, end?: number, contentType?: string): Blob {
    const part = super.slice(start, end, contentType)
    this.slicedBytes += part.size
    return part
  }
}

it.each(['STORE', 'DEFLATE'] as const)('reads only selected %s entries, including streamed ZIP data descriptors', async (compression) => {
  const zip = new JSZip()
  zip.file('capture/metadata', 'calibrated screen')
  zip.file('other-capture/unused', new Uint8Array(2 * 1024 * 1024), { compression: 'STORE' })
  const bytes = await zip.generateAsync({ type: 'uint8array', compression, streamFiles: true })
  const file = new TrackingFile([bytes.slice().buffer], 'screen.zag')
  const archive = await FileZipArchive.open(file)
  expect(new TextDecoder().decode(await archive.file('capture/metadata')!.read())).toBe('calibrated screen')
  expect(file.slicedBytes).toBeLessThan(100_000)
  expect(archive.file('other-capture/unused')!.data.uncompressedSize).toBe(2 * 1024 * 1024)
})

it('rejects truncated archives and a directory outside the file before reading payloads', async () => {
  const zip = new JSZip().file('entry', 'height')
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  await expect(FileZipArchive.open(new File([bytes.slice(0, -5).buffer], 'truncated.zag'))).rejects.toThrow(/不完整/)
  const forged = bytes.slice()
  new DataView(forged.buffer).setUint32(forged.length - 22 + 16, 0xfffffff0, true)
  await expect(FileZipArchive.open(new File([forged.buffer], 'forged.zag'))).rejects.toThrow(/目录超出/)
})

it('honors cancellation without reading an archive', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(FileZipArchive.open(new File(['not a zip'], 'scan.zag'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it('supports a preview prefix and ZIP64 directory records used by KEYENCE projects', async () => {
  const original = await new JSZip().file('calibration', 'physical units').generateAsync({ type: 'uint8array' })
  const endOffset = original.length - 22
  const originalEnd = new DataView(original.buffer, original.byteOffset + endOffset, 22)
  const count = originalEnd.getUint16(10, true)
  const directorySize = originalEnd.getUint32(12, true)
  const directoryOffset = originalEnd.getUint32(16, true)
  const zip64 = new Uint8Array(56)
  const view = new DataView(zip64.buffer)
  view.setUint32(0, 0x06064b50, true)
  view.setBigUint64(4, 44n, true)
  view.setUint16(12, 45, true)
  view.setUint16(14, 45, true)
  view.setBigUint64(24, BigInt(count), true)
  view.setBigUint64(32, BigInt(count), true)
  view.setBigUint64(40, BigInt(directorySize), true)
  view.setBigUint64(48, BigInt(directoryOffset), true)
  const locator = new Uint8Array(20)
  const locatorView = new DataView(locator.buffer)
  locatorView.setUint32(0, 0x07064b50, true)
  locatorView.setBigUint64(8, BigInt(endOffset), true)
  locatorView.setUint32(16, 1, true)
  const end = original.slice(endOffset)
  new DataView(end.buffer).setUint16(8, 65535, true)
  new DataView(end.buffer).setUint16(10, 65535, true)
  const file = new TrackingFile(['preview prefix', original.slice(0, endOffset).buffer, zip64.buffer, locator.buffer, end.buffer], 'prefixed.zag')
  const archive = await FileZipArchive.open(file)
  expect(new TextDecoder().decode(await archive.file('calibration')!.read())).toBe('physical units')
})
