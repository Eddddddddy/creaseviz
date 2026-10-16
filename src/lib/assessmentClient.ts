import type { RegionBounds } from '../types'
import type { ZagRegionSource } from './zagRegion'
import type { AssessmentOptions, AssessmentResult } from './assessmentTypes'
import { assertNotAborted } from './fileLimits'
import { fullModelRegion } from './region'

export function assessmentSourceBounds(source: Parameters<typeof fullModelRegion>[0], selection?: RegionBounds): RegionBounds {
  const bounds = selection ?? fullModelRegion(source)
  return { x: [...bounds.x], y: [...bounds.y], z: [...bounds.z] }
}

export function calculateAssessment(source: ZagRegionSource, bounds: RegionBounds, options: AssessmentOptions,
  signal: AbortSignal, onProgress: (value: number) => void): Promise<AssessmentResult> {
  assertNotAborted(signal)
  const worker = new Worker(new URL('../workers/assessmentWorker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true; window.clearTimeout(timeout); signal.removeEventListener('abort', abort); worker.terminate(); action()
    }
    const abort = () => finish(() => reject(new DOMException('评估已取消', 'AbortError')))
    const timeout = window.setTimeout(() => finish(() => reject(new Error('评估超时，请缩小选区或增大分析间距'))), 120_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => finish(() => reject(new Error(event.message || '评估 Worker 失败')))
    worker.onmessageerror = () => finish(() => reject(new Error('评估返回了无效数据')))
    worker.onmessage = (event: MessageEvent<{ type: 'progress' | 'result' | 'error'; result: AssessmentResult; error: string; progress: number }>) => {
      if (settled) return
      if (event.data.type === 'progress') onProgress(event.data.progress)
      else if (event.data.type === 'error') finish(() => reject(new Error(event.data.error)))
      else finish(() => resolve(event.data.result))
    }
    // Never detach the matrices retained by the viewer and OBJ exporter.
    try { worker.postMessage({ source, bounds, options }) }
    catch (cause) { finish(() => reject(cause instanceof Error ? cause : new Error('无法启动评估'))) }
  })
}
