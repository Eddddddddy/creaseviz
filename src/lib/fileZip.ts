import JSZip from 'jszip'
import { FILE_LIMITS, assertNotAborted, validateZipBudget } from './fileLimits'

/** A ZIP directory stays in memory; entry payloads are read from File on demand. */
export class FileZipEntry {
  readonly dir: boolean

  constructor(
    readonly name: string,
    readonly data: { compressedSize: number; uncompressedSize: number; crc32: number },
    private readonly file: File,
    private readonly offset: number,
    private readonly centralRecord: Uint8Array,
    private readonly directoryOffset: number,
  ) {
    this.dir = name.endsWith('/')
  }

  async read(): Promise<Uint8Array> {
    const header = new DataView(await this.file.slice(this.offset, this.offset + 30).arrayBuffer())
    if (header.byteLength !== 30 || header.getUint32(0, true) !== 0x04034b50) throw new Error('ZAG ZIP 条目头无效')
    if (header.getUint16(6, true) & 1) throw new Error('不支持加密的 ZAG ZIP 条目')
    const headerSize = 30 + header.getUint16(26, true) + header.getUint16(28, true)
    const end = this.offset + headerSize + this.data.compressedSize
    if (end > this.directoryOffset || this.data.compressedSize > this.data.uncompressedSize + 65_536) {
      throw new Error('ZAG ZIP 条目尺寸无效')
    }
    const local = new Uint8Array(await this.file.slice(this.offset, end).arrayBuffer())
    // JSZip handles STORE/DEFLATE and ZIP name encoding. Give it a single-entry
    // archive instead of copying the entire multi-capture project into memory.
    const central = this.centralRecord.slice()
    const centralView = new DataView(central.buffer)
    centralView.setUint32(20, this.data.compressedSize, true)
    centralView.setUint32(24, this.data.uncompressedSize, true)
    centralView.setUint32(42, 0, true)
    const endRecord = new Uint8Array(22)
    const view = new DataView(endRecord.buffer)
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(8, 1, true)
    view.setUint16(10, 1, true)
    view.setUint32(12, central.length, true)
    view.setUint32(16, local.length, true)
    const bytes = new Uint8Array(local.length + central.length + endRecord.length)
    bytes.set(local)
    bytes.set(central, local.length)
    bytes.set(endRecord, local.length + central.length)
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: false })
    const entry = zip.file(this.name)
    if (!entry) throw new Error(`无法读取 ZAG ZIP 条目：${this.name}`)
    return entry.async('uint8array')
  }
}

export class FileZipArchive {
  readonly files: Record<string, FileZipEntry> = Object.create(null)

  static async open(file: File, signal?: AbortSignal): Promise<FileZipArchive> {
    assertNotAborted(signal)
    const tailOffset = Math.max(0, file.size - 65_557)
    const tail = new DataView(await file.slice(tailOffset).arrayBuffer())
    let endOffset = -1
    for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
      if (tail.getUint32(offset, true) === 0x06054b50
        && offset + 22 + tail.getUint16(offset + 20, true) === tail.byteLength) {
        endOffset = offset
        break
      }
    }
    if (endOffset < 0) throw new Error('ZAG ZIP 目录缺失或文件不完整')
    let count = tail.getUint16(endOffset + 10, true)
    let directorySize = tail.getUint32(endOffset + 12, true)
    let storedDirectoryOffset = tail.getUint32(endOffset + 16, true)
    if (tail.getUint16(endOffset + 4, true) || tail.getUint16(endOffset + 6, true)
      || tail.getUint16(endOffset + 8, true) !== count) throw new Error('不支持分卷 ZAG ZIP')
    const uint64 = (view: DataView, offset: number): number => {
      if (offset + 8 > view.byteLength) throw new Error('ZAG ZIP64 字段被截断')
      const value = view.getBigUint64(offset, true)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZAG ZIP64 数值超过安全范围')
      return Number(value)
    }
    let prefixSize = tailOffset + endOffset - directorySize - storedDirectoryOffset
    let directoryEnd = tailOffset + endOffset
    if (endOffset >= 20 && tail.getUint32(endOffset - 20, true) === 0x07064b50) {
      const locator = endOffset - 20
      if (tail.getUint32(locator + 4, true) !== 0 || tail.getUint32(locator + 16, true) !== 1) throw new Error('不支持分卷 ZIP64')
      let zip64 = -1
      for (let offset = locator - 56; offset >= 0; offset -= 1) {
        if (tail.getUint32(offset, true) === 0x06064b50 && offset + 12 + uint64(tail, offset + 4) === locator) {
          zip64 = offset
          break
        }
      }
      if (zip64 < 0) throw new Error('ZAG ZIP64 目录记录缺失')
      count = uint64(tail, zip64 + 32)
      if (tail.getUint32(zip64 + 16, true) || tail.getUint32(zip64 + 20, true)
        || uint64(tail, zip64 + 24) !== count) throw new Error('不支持分卷 ZIP64')
      directorySize = uint64(tail, zip64 + 40)
      storedDirectoryOffset = uint64(tail, zip64 + 48)
      prefixSize = tailOffset + zip64 - uint64(tail, locator + 8)
      directoryEnd = tailOffset + zip64
    }
    const directoryOffset = storedDirectoryOffset + prefixSize
    if (prefixSize < 0 || count > FILE_LIMITS.zagEntryCount || directorySize > 16 * 1024 * 1024
      || directoryOffset + directorySize > directoryEnd) throw new Error('ZAG ZIP 目录超出允许范围')
    const bytes = new Uint8Array(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer())
    const directory = new DataView(bytes.buffer)
    const archive = new FileZipArchive()
    const budget = []
    let cursor = 0
    for (let index = 0; index < count; index += 1) {
      assertNotAborted(signal)
      if (cursor + 46 > bytes.length || directory.getUint32(cursor, true) !== 0x02014b50) {
        throw new Error('ZAG ZIP 目录条目无效')
      }
      const nameLength = directory.getUint16(cursor + 28, true)
      const recordSize = 46 + nameLength + directory.getUint16(cursor + 30, true) + directory.getUint16(cursor + 32, true)
      if (cursor + recordSize > bytes.length) throw new Error('ZAG ZIP 目录条目被截断')
      const name = new TextDecoder('utf-8').decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
      const method = directory.getUint16(cursor + 10, true)
      let localOffset = directory.getUint32(cursor + 42, true)
      let compressedSize = directory.getUint32(cursor + 20, true)
      let uncompressedSize = directory.getUint32(cursor + 24, true)
      if (localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        let extra = cursor + 46 + nameLength
        const extraEnd = extra + directory.getUint16(cursor + 30, true)
        let found = false
        while (extra + 4 <= extraEnd) {
          const kind = directory.getUint16(extra, true)
          const length = directory.getUint16(extra + 2, true)
          if (extra + 4 + length > extraEnd) throw new Error('ZAG ZIP64 扩展字段被截断')
          if (kind === 1) {
            const extended = new DataView(bytes.buffer, extra + 4, length)
            let position = 0
            if (uncompressedSize === 0xffffffff) { uncompressedSize = uint64(extended, position); position += 8 }
            if (compressedSize === 0xffffffff) { compressedSize = uint64(extended, position); position += 8 }
            if (localOffset === 0xffffffff) localOffset = uint64(extended, position)
            found = true
            break
          }
          extra += 4 + length
        }
        if (!found) throw new Error('ZAG ZIP64 扩展字段缺失')
      }
      localOffset += prefixSize
      if ((directory.getUint16(cursor + 8, true) & 1) || (method !== 0 && method !== 8)
        || directory.getUint16(cursor + 34, true) !== 0 || localOffset + 30 > directoryOffset) {
        throw new Error('ZAG ZIP 包含不支持的条目')
      }
      if (Object.hasOwn(archive.files, name)) throw new Error('ZAG ZIP 包含重复条目名称')
      const data = {
        compressedSize,
        uncompressedSize,
        crc32: directory.getUint32(cursor + 16, true),
      }
      const entry = new FileZipEntry(name, data, file, localOffset, bytes.slice(cursor, cursor + recordSize), directoryOffset)
      archive.files[name] = entry
      budget.push({ name, directory: entry.dir, ...data })
      cursor += recordSize
    }
    if (cursor !== bytes.length) throw new Error('ZAG ZIP 目录长度不匹配')
    validateZipBudget(budget)
    return archive
  }

  file(name: string): FileZipEntry | undefined {
    const entry = this.files[name]
    return entry?.dir ? undefined : entry
  }
}
