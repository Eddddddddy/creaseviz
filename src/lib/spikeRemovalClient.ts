import { assertNotAborted, FILE_LIMITS } from './fileLimits'
import type { SpikeRemovalOptions, SpikeRemovalStats } from './spikeRemoval'
import type { ZagRegionSource } from './zagRegion'

export function repairZagSpikes(source: ZagRegionSource, options: SpikeRemovalOptions,
  signal: AbortSignal, onProgress: (value: number) => void): Promise<{ heights: Int32Array; stats: SpikeRemovalStats }> {
  assertNotAborted(signal)
  const worker = new Worker(new URL('../workers/spikeWorker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      worker.terminate()
      action()
    }
    const abort = () => finish(() => reject(new DOMException('去尖刺已取消', 'AbortError')))
    const timeout = window.setTimeout(() => finish(() => reject(new Error('去尖刺超时，请重试或使用较小数据'))), FILE_LIMITS.workerTimeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => finish(() => reject(new Error(event.message || '去尖刺处理失败')))
    worker.onmessageerror = () => finish(() => reject(new Error('去尖刺返回了无效数据')))
    worker.onmessage = (event: MessageEvent<{
      type: 'progress' | 'error' | 'result'; progress: number; error: string; heights: Int32Array; stats: SpikeRemovalStats
    }>) => {
      if (settled) return
      if (event.data.type === 'progress') onProgress(event.data.progress)
      else if (event.data.type === 'error') finish(() => reject(new Error(event.data.error)))
      else finish(() => resolve({ heights: event.data.heights, stats: event.data.stats }))
    }
    // Clone rather than transfer: the original model must remain immediately restorable.
    try {
      worker.postMessage({ source, options })
    } catch (cause) {
      finish(() => reject(cause instanceof Error ? cause : new Error('无法启动去尖刺处理')))
    }
  })
}
