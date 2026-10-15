import * as THREE from 'three'
import type { ViewerModel, ZagHeightField } from '../types'
import { FILE_LIMITS, assertNotAborted, inspectStlHeader, validateZagDimensions } from './fileLimits'
import { createScientificPalette } from './palette'

type SourceField = Pick<ZagHeightField, 'heights' | 'mask' | 'maskStride'>
// Keep raw matrices outside React props/state and release them with the model.
const zagSources = new WeakMap<THREE.BufferGeometry, SourceField>()

export function getZagModelSource(model: ViewerModel): SourceField | undefined {
  return zagSources.get(model.geometry)
}

export function disposeViewerModel(model: ViewerModel): void {
  zagSources.delete(model.geometry)
  model.geometry.dispose()
}

interface WorkerResult {
  type: 'zag-mesh-result'
  sourceHeights: ArrayBuffer
  sourceMask: ArrayBuffer
  positions: ArrayBuffer
  uvs: ArrayBuffer
  scalars: ArrayBuffer
  crossSectionRows: ArrayBuffer
  indices: ArrayBuffer
  crossSections: ArrayBuffer[]
  crossSectionX: ArrayBuffer
  textureRgba?: ArrayBuffer
  textureWidth?: number
  textureHeight?: number
  sampledWidth: number
  sampledHeight: number
  sampleStep: number
  validPointCount: number
  minHeightMm: number
  maxHeightMm: number
  suggestedMinMm: number
  suggestedMaxMm: number
  triangleCount: number
}

interface StlWorkerResult {
  type: 'stl-result'
  positions: ArrayBuffer
  normals: ArrayBuffer
  cross: ArrayBuffer
  crossX: ArrayBuffer
  bounds: [number, number, number, number, number, number]
  suggestedMinMm: number
  suggestedMaxMm: number
  triangleCount: number
  originalPointCount: number
  renderedPointCount: number
  sampleStep: number
}

function runWorker<Result>(
  worker: Worker,
  message: unknown,
  transfers: Transferable[],
  signal?: AbortSignal,
): Promise<Result> {
  assertNotAborted(signal)
  return new Promise<Result>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      action()
    }
    const abort = () => finish(() => reject(new DOMException('模型处理已取消', 'AbortError')))
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error('模型处理超时；请降低文件规模后重试'))),
      FILE_LIMITS.workerTimeoutMs,
    )
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<Result>) => finish(() => resolve(event.data))
    worker.onerror = (event) => finish(() => reject(new Error(event.message || '模型 Worker 处理失败')))
    worker.onmessageerror = () => finish(() => reject(new Error('模型 Worker 返回了无效数据')))
    worker.postMessage(message, transfers)
  })
}

export async function zagFieldToModel(
  field: ZagHeightField,
  fileName: string,
  targetVertices = 220_000,
  signal?: AbortSignal,
): Promise<ViewerModel> {
  validateZagDimensions(field.capture.width, field.capture.height)
  const worker = new Worker(new URL('../workers/meshWorker.ts', import.meta.url), { type: 'module' })
  const transfers: Transferable[] = [field.heights.buffer, field.mask.buffer]
  if (field.color) transfers.push(field.color.buffer)
  const result = await runWorker<WorkerResult>(worker, {
    type: 'build-zag',
    heights: field.heights.buffer,
    mask: field.mask.buffer,
    color: field.color?.buffer,
    width: field.capture.width,
    height: field.capture.height,
    maskStride: field.maskStride,
    colorStride: field.colorStride,
    xyPitchMm: field.capture.xyPitchMm,
    zUnitMm: field.capture.zUnitMm,
    targetVertices,
  }, transfers, signal)

  const heightSamples = new Float32Array(result.scalars)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.positions), 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(result.uvs), 2))
  geometry.setAttribute('heightValue', new THREE.BufferAttribute(heightSamples, 1))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(result.indices), 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()

  zagSources.set(geometry, {
    heights: new Int32Array(result.sourceHeights),
    mask: new Uint8Array(result.sourceMask),
    maskStride: field.maskStride,
  })

  return {
    kind: 'zag',
    fileName,
    label: field.capture.name,
    geometry,
    palette: field.palette.byteLength >= 768 ? field.palette.slice(0, 768) : createScientificPalette(),
    textureRgba: result.textureRgba ? new Uint8ClampedArray(result.textureRgba) : undefined,
    textureWidth: result.textureWidth,
    textureHeight: result.textureHeight,
    widthMm: (field.capture.width - 1) * field.capture.xyPitchMm,
    lengthMm: (field.capture.height - 1) * field.capture.xyPitchMm,
    minHeightMm: result.minHeightMm,
    maxHeightMm: result.maxHeightMm,
    suggestedMinMm: result.suggestedMinMm,
    suggestedMaxMm: result.suggestedMaxMm,
    triangleCount: result.triangleCount,
    originalPointCount: field.capture.width * field.capture.height,
    renderedPointCount: result.validPointCount,
    sampleStep: result.sampleStep,
    heightAxis: [0, 1, 0],
    rotationX: 0,
    scaleOrder: 'zag',
    sectionSamples: new Float32Array(result.crossSectionRows),
    sectionWidth: result.sampledWidth,
    sectionCount: field.capture.height,
    crossSections: result.crossSections.map((buffer) => new Float32Array(buffer)),
    crossSectionX: new Float32Array(result.crossSectionX),
    capture: field.capture,
    hasSourceData: true,
  }
}

export async function zagTextureToRgba(
  color: Uint8Array,
  width: number,
  height: number,
  colorStride: number,
  signal?: AbortSignal,
): Promise<Uint8ClampedArray> {
  validateZagDimensions(width, height)
  const worker = new Worker(new URL('../workers/meshWorker.ts', import.meta.url), { type: 'module' })
  const result = await runWorker<{ type: 'texture-result'; textureRgba: ArrayBuffer }>(
    worker,
    { type: 'build-texture', color: color.buffer, width, height, colorStride },
    [color.buffer],
    signal,
  )
  return new Uint8ClampedArray(result.textureRgba)
}

export async function stlFileToModel(file: File, signal?: AbortSignal): Promise<ViewerModel> {
  assertNotAborted(signal)
  const header = new Uint8Array(await file.slice(0, 84).arrayBuffer())
  const inspection = inspectStlHeader(file.size, header)
  assertNotAborted(signal)
  const bytes = await file.arrayBuffer()
  assertNotAborted(signal)
  const worker = new Worker(new URL('../workers/stlWorker.ts', import.meta.url), { type: 'module' })
  const result = await runWorker<StlWorkerResult>(worker, {
    type: 'parse-stl',
    bytes,
    format: inspection.format,
    triangleCount: inspection.triangleCount,
  }, [bytes], signal)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.positions), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(result.normals), 3))
  const [minX, minY, minZ, maxX, maxY, maxZ] = result.bounds
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ))
  geometry.computeBoundingSphere()
  const cross = new Float32Array(result.cross)
  const crossX = new Float32Array(result.crossX)

  return {
    kind: 'stl',
    fileName: file.name,
    label: file.name,
    geometry,
    palette: createScientificPalette(),
    widthMm: maxX - minX,
    lengthMm: maxY - minY,
    minHeightMm: minZ,
    maxHeightMm: maxZ,
    suggestedMinMm: result.suggestedMinMm,
    suggestedMaxMm: result.suggestedMaxMm,
    triangleCount: result.triangleCount,
    originalPointCount: result.originalPointCount,
    renderedPointCount: result.renderedPointCount,
    sampleStep: result.sampleStep,
    heightAxis: [0, 0, 1],
    rotationX: -Math.PI / 2,
    scaleOrder: 'stl',
    crossSections: [cross],
    crossSectionX: crossX,
    warning: 'STL 不保存物理单位或导出时的高度放大倍率；精确 Z 值请以配套 ZAG 为准。',
  }
}
