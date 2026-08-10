/// <reference lib="webworker" />

import { createObjBlob, type ObjMeshInput } from '../lib/objExport'

interface ObjWorkerRequest extends Omit<ObjMeshInput, 'positions' | 'indices' | 'uvs'> {
  type: 'export-obj'
  positions: ArrayBuffer
  indices?: ArrayBuffer
  uvs?: ArrayBuffer
}

self.onmessage = (event: MessageEvent<ObjWorkerRequest>) => {
  if (event.data.type !== 'export-obj') throw new Error('未知 OBJ Worker 消息')
  const { positions, indices, uvs, name, scaleX, scaleY, scaleZ, scaleMode } = event.data
  const result = createObjBlob({
    name,
    scaleX,
    scaleY,
    scaleZ,
    scaleMode,
    positions: new Float32Array(positions),
    indices: indices ? new Uint32Array(indices) : undefined,
    uvs: uvs ? new Float32Array(uvs) : undefined,
  }, (progress) => self.postMessage({ type: 'obj-progress', progress }))
  self.postMessage({ type: 'obj-result', blob: result.blob, summary: result.summary })
}

export {}
