/// <reference lib="webworker" />

import { createObjBlob, type ObjMeshInput } from '../lib/objExport'
import { buildZagRegionMesh } from '../lib/zagRegion'
import type { CaptureSummary, ObjDetail, RegionBounds } from '../types'

interface ObjWorkerRequest extends Omit<ObjMeshInput, 'positions' | 'indices' | 'uvs'> {
  type: 'export-obj'
  positions: ArrayBuffer
  indices?: ArrayBuffer
  uvs?: ArrayBuffer
  source?: {
    heights: ArrayBuffer
    mask: ArrayBuffer
    maskStride: number
    capture: CaptureSummary
    bounds: RegionBounds
    detail: ObjDetail
  }
}

function exportObj(message: ObjWorkerRequest) {
  if (message.type !== 'export-obj') throw new Error('未知 OBJ Worker 消息')
  const { positions, indices, uvs, name, scaleX, scaleY, scaleZ, scaleMode, source, region } = message
  const mesh = source
    ? buildZagRegionMesh({
      ...source,
      heights: new Int32Array(source.heights),
      mask: new Uint8Array(source.mask),
    }, source.bounds, source.detail, (progress) => self.postMessage({ type: 'obj-progress', progress: progress * 0.4 }))
    : {
      positions: new Float32Array(positions),
      indices: indices ? new Uint32Array(indices) : undefined,
      uvs: uvs ? new Float32Array(uvs) : undefined,
      sampleStep: undefined,
    }
  const result = createObjBlob({
    name,
    scaleX,
    scaleY,
    scaleZ,
    scaleMode,
    ...mesh,
    region,
    sampleStep: mesh.sampleStep,
  }, (progress) => self.postMessage({ type: 'obj-progress', progress: source ? 0.4 + progress * 0.6 : progress }))
  self.postMessage({ type: 'obj-result', blob: result.blob, summary: result.summary })
}

self.onmessage = (event: MessageEvent<ObjWorkerRequest>) => {
  try {
    exportObj(event.data)
  } catch (cause) {
    self.postMessage({ type: 'obj-error', error: cause instanceof Error ? cause.message : 'OBJ 生成失败' })
  }
}

export {}
