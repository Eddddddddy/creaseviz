import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { ViewerModel, ZagHeightField } from '../types'
import { createScientificPalette } from './palette'

interface WorkerResult {
  type: 'zag-mesh-result'
  positions: ArrayBuffer
  uvs: ArrayBuffer
  scalars: ArrayBuffer
  crossSectionRows: ArrayBuffer
  indices: ArrayBuffer
  crossSections: ArrayBuffer[]
  crossSectionX: ArrayBuffer
  textureRgba?: ArrayBuffer
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

export async function zagFieldToModel(
  field: ZagHeightField,
  fileName: string,
  targetVertices = 220_000,
): Promise<ViewerModel> {
  const worker = new Worker(new URL('../workers/meshWorker.ts', import.meta.url), { type: 'module' })
  const result = await new Promise<WorkerResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResult>) => resolve(event.data)
    worker.onerror = (event) => reject(new Error(event.message || 'ZAG 网格构建失败'))
    const transfers: Transferable[] = [field.heights.buffer, field.mask.buffer]
    if (field.color) transfers.push(field.color.buffer)
    worker.postMessage(
      {
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
      },
      transfers,
    )
  }).finally(() => worker.terminate())

  const heightSamples = new Float32Array(result.scalars)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.positions), 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(result.uvs), 2))
  geometry.setAttribute('heightValue', new THREE.BufferAttribute(heightSamples, 1))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(result.indices), 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()

  return {
    kind: 'zag',
    fileName,
    label: field.capture.name,
    geometry,
    palette: field.palette.byteLength >= 768 ? field.palette.slice(0, 768) : createScientificPalette(),
    textureRgba: result.textureRgba ? new Uint8ClampedArray(result.textureRgba) : undefined,
    textureWidth: field.capture.width,
    textureHeight: field.capture.height,
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
  }
}

export async function zagTextureToRgba(
  color: Uint8Array,
  width: number,
  height: number,
  colorStride: number,
): Promise<Uint8ClampedArray> {
  const worker = new Worker(new URL('../workers/meshWorker.ts', import.meta.url), { type: 'module' })
  const result = await new Promise<{ type: 'texture-result'; textureRgba: ArrayBuffer }>((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data)
    worker.onerror = (event) => reject(new Error(event.message || 'ZAG 纹理转换失败'))
    worker.postMessage(
      { type: 'build-texture', color: color.buffer, width, height, colorStride },
      [color.buffer],
    )
  }).finally(() => worker.terminate())
  return new Uint8ClampedArray(result.textureRgba)
}

export async function stlFileToModel(file: File): Promise<ViewerModel> {
  const bytes = await file.arrayBuffer()
  const geometry = new STLLoader().parse(bytes)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  const box = geometry.boundingBox!
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const triangleCount = position.count / 3
  const step = Math.max(1, Math.floor(position.count / 180_000))
  const values: number[] = []
  for (let index = 0; index < position.count; index += step) values.push(position.getZ(index))
  values.sort((a, b) => a - b)
  const percentile = (ratio: number) => values[Math.floor((values.length - 1) * ratio)] ?? 0
  const sectionBins = 500
  const sums = new Float64Array(sectionBins)
  const counts = new Uint32Array(sectionBins)
  const yMid = (box.min.y + box.max.y) / 2
  const band = Math.max((box.max.y - box.min.y) / 300, 0.002)
  for (let index = 0; index < position.count; index += 1) {
    if (Math.abs(position.getY(index) - yMid) > band) continue
    const ratio = (position.getX(index) - box.min.x) / Math.max(1e-9, box.max.x - box.min.x)
    const bin = Math.min(sectionBins - 1, Math.max(0, Math.floor(ratio * sectionBins)))
    sums[bin] += position.getZ(index)
    counts[bin] += 1
  }
  const cross = new Float32Array(sectionBins)
  const crossX = new Float32Array(sectionBins)
  for (let index = 0; index < sectionBins; index += 1) {
    cross[index] = counts[index] ? sums[index] / counts[index] : Number.NaN
    crossX[index] = box.min.x + ((index + 0.5) / sectionBins) * (box.max.x - box.min.x)
  }

  return {
    kind: 'stl',
    fileName: file.name,
    label: file.name,
    geometry,
    palette: createScientificPalette(),
    widthMm: box.max.x - box.min.x,
    lengthMm: box.max.y - box.min.y,
    minHeightMm: box.min.z,
    maxHeightMm: box.max.z,
    suggestedMinMm: percentile(0.01),
    suggestedMaxMm: percentile(0.99),
    triangleCount,
    originalPointCount: position.count,
    renderedPointCount: position.count,
    sampleStep: 1,
    heightAxis: [0, 0, 1],
    rotationX: -Math.PI / 2,
    scaleOrder: 'stl',
    crossSections: [cross],
    crossSectionX: crossX,
    warning: 'STL 不保存物理单位或导出时的高度放大倍率；精确 Z 值请以配套 ZAG 为准。',
  }
}
