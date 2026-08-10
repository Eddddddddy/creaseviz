import type { ViewerModel } from '../types'
import { OBJ_LIMITS, safeObjFileName, type ObjMeshSummary, type ObjScaleMode } from './objExport'

export interface ObjExportOptions {
  scaleMode: ObjScaleMode
  scaleX: number
  scaleY: number
  scaleZ: number
  signal?: AbortSignal
  onProgress?: (progress: number) => void
}

export interface ObjExportResult extends ObjMeshSummary {
  blob: Blob
  fileName: string
}

function copyAttribute(
  attribute: { count: number; getX(index: number): number; getY(index: number): number; getZ(index: number): number },
): Float32Array {
  const result = new Float32Array(attribute.count * 3)
  for (let index = 0; index < attribute.count; index += 1) {
    const offset = index * 3
    result[offset] = attribute.getX(index)
    result[offset + 1] = attribute.getY(index)
    result[offset + 2] = attribute.getZ(index)
  }
  return result
}

function copyUvs(attribute?: { count: number; getX(index: number): number; getY(index: number): number }): Float32Array | undefined {
  if (!attribute) return undefined
  const result = new Float32Array(attribute.count * 2)
  for (let index = 0; index < attribute.count; index += 1) {
    const offset = index * 2
    result[offset] = attribute.getX(index)
    result[offset + 1] = attribute.getY(index)
  }
  return result
}

export function createViewerModelObj(
  model: ViewerModel,
  options: ObjExportOptions,
): Promise<ObjExportResult> {
  if (model.kind !== 'zag') return Promise.reject(new Error('OBJ 转换当前仅支持 ZAG 高度场'))
  if (options.signal?.aborted) return Promise.reject(new DOMException('OBJ 导出已取消', 'AbortError'))

  const position = model.geometry.getAttribute('position')
  if (!position || position.itemSize < 3) return Promise.reject(new Error('当前 ZAG 没有可导出的三维网格'))
  const uv = model.geometry.getAttribute('uv')
  if (uv && uv.count !== position.count) return Promise.reject(new Error('当前 ZAG 的 UV 数据不完整'))
  const positions = copyAttribute(position)
  const uvs = copyUvs(uv)
  const geometryIndex = model.geometry.getIndex()
  const indices = geometryIndex
    ? Uint32Array.from({ length: geometryIndex.count }, (_, index) => geometryIndex.getX(index))
    : undefined
  const scaleX = options.scaleMode === 'true' ? 1 : options.scaleX
  const scaleY = options.scaleMode === 'true' ? 1 : options.scaleY
  const scaleZ = options.scaleMode === 'true' ? 1 : options.scaleZ
  const worker = new Worker(new URL('../workers/objWorker.ts', import.meta.url), { type: 'module' })

  return new Promise<ObjExportResult>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      worker.terminate()
      action()
    }
    const abort = () => finish(() => reject(new DOMException('OBJ 导出已取消', 'AbortError')))
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error('OBJ 生成超时，请降低网格规模后重试'))),
      OBJ_LIMITS.workerTimeoutMs,
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'OBJ Worker 生成失败')))
    worker.onmessageerror = () => finish(() => reject(new Error('OBJ Worker 返回了无效数据')))
    worker.onmessage = (event: MessageEvent<{
      type: 'obj-progress' | 'obj-result'
      progress?: number
      blob?: Blob
      summary?: ObjMeshSummary
    }>) => {
      if (event.data.type === 'obj-progress') {
        options.onProgress?.(event.data.progress ?? 0)
        return
      }
      const { blob, summary } = event.data
      if (!blob || !summary || blob.size === 0) {
        finish(() => reject(new Error('OBJ Worker 没有生成有效文件')))
        return
      }
      finish(() => resolve({
        ...summary,
        blob,
        fileName: safeObjFileName(model.label || model.fileName, options.scaleMode),
      }))
    }

    const transfers: Transferable[] = [positions.buffer]
    if (indices) transfers.push(indices.buffer)
    if (uvs) transfers.push(uvs.buffer)
    worker.postMessage({
      type: 'export-obj',
      name: model.label || model.fileName,
      positions: positions.buffer,
      indices: indices?.buffer,
      uvs: uvs?.buffer,
      scaleX,
      scaleY,
      scaleZ,
      scaleMode: options.scaleMode,
    }, transfers)
  })
}

export function downloadObj(result: Pick<ObjExportResult, 'blob' | 'fileName'>): void {
  const url = URL.createObjectURL(result.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 15_000)
}
