import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { repairZagSpikes } from './spikeRemovalClient'
import { DEFAULT_SPIKE_OPTIONS } from './spikeRemoval'
import { FILE_LIMITS } from './fileLimits'

class WorkerStub {
  static instances: WorkerStub[] = []
  terminate = vi.fn()
  postMessage = vi.fn()
  onmessage?: (event: { data: unknown }) => void
  onerror?: (event: { message: string }) => void
  onmessageerror?: () => void
  constructor() { WorkerStub.instances.push(this) }
}

const source = {
  heights: new Int32Array(100), mask: new Uint8Array(120), maskStride: 12,
  capture: { width: 10, height: 10, xyPitchMm: 0.1, zUnitMm: 0.00001 },
}

describe('spike worker lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    WorkerStub.instances = []
    vi.stubGlobal('Worker', WorkerStub)
    vi.stubGlobal('window', globalThis)
  })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('never starts a job that is already cancelled', () => {
    const controller = new AbortController(); controller.abort()
    expect(() => repairZagSpikes(source, DEFAULT_SPIKE_OPTIONS, controller.signal, vi.fn())).toThrow()
    expect(WorkerStub.instances).toHaveLength(0)
  })

  it('clones input without transferring/detaching it, reports progress and returns result', async () => {
    const controller = new AbortController(), progress = vi.fn()
    const pending = repairZagSpikes(source, DEFAULT_SPIKE_OPTIONS, controller.signal, progress)
    const worker = WorkerStub.instances[0]
    expect(worker.postMessage).toHaveBeenCalledWith({ source, options: DEFAULT_SPIKE_OPTIONS })
    expect(source.heights.byteLength).toBe(400)
    worker.onmessage?.({ data: { type: 'progress', progress: 0.6 } })
    expect(progress).toHaveBeenCalledWith(0.6)
    const result = { heights: new Int32Array(100), stats: { changedCount: 1 } }
    worker.onmessage?.({ data: { type: 'result', ...result } })
    await expect(pending).resolves.toEqual(result)
    expect(worker.terminate).toHaveBeenCalledOnce()
    controller.abort()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('cancels and terminates a running job without a late result taking effect', async () => {
    const controller = new AbortController()
    const pending = repairZagSpikes(source, DEFAULT_SPIKE_OPTIONS, controller.signal, vi.fn())
    const worker = WorkerStub.instances[0]
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    worker.onmessage?.({ data: { type: 'result', heights: new Int32Array(100), stats: {} } })
    await rejection
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(source.heights.byteLength).toBe(400)
  })

  it('rejects a timeout and releases the worker', async () => {
    const pending = repairZagSpikes(source, DEFAULT_SPIKE_OPTIONS, new AbortController().signal, vi.fn())
    const rejection = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(FILE_LIMITS.workerTimeoutMs + 1)
    await rejection
    expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce()
  })

  it('reports algorithm failure without touching the original', async () => {
    const pending = repairZagSpikes(source, DEFAULT_SPIKE_OPTIONS, new AbortController().signal, vi.fn())
    const rejection = expect(pending).rejects.toThrow('参数无效')
    WorkerStub.instances[0].onmessage?.({ data: { type: 'error', error: '参数无效' } })
    await rejection
    expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce()
    expect(source.heights.byteLength).toBe(400)
  })

  it('reports a worker failure and releases resources', async () => {
    const pending = repairZagSpikes(source, DEFAULT_SPIKE_OPTIONS, new AbortController().signal, vi.fn())
    const rejection = expect(pending).rejects.toThrow('Worker failed')
    WorkerStub.instances[0].onerror?.({ message: 'Worker failed' })
    await rejection
    expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce()
  })
})
