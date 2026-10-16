import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assessmentSourceBounds, calculateAssessment } from './assessmentClient'
import { DEFAULT_ASSESSMENT_OPTIONS } from './assessmentTypes'

class WorkerStub {
  static instances: WorkerStub[] = []
  terminate = vi.fn()
  postMessage = vi.fn()
  onmessage?: (event: { data: unknown }) => void
  onerror?: (event: { message: string }) => void
  onmessageerror?: () => void
  constructor() { WorkerStub.instances.push(this) }
}
const source = { heights: new Int32Array(100), mask: new Uint8Array(120), maskStride: 12,
  capture: { width: 10, height: 10, xyPitchMm: .1, zUnitMm: .00001 } }
const bounds = { x: [0, 1] as [number, number], y: [0, 1] as [number, number], z: [-1, 1] as [number, number] }

describe('assessment source scope and lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); WorkerStub.instances = []; vi.stubGlobal('Worker', WorkerStub); vi.stubGlobal('window', globalThis) })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('full original scope uses the original extrema, not a repaired model or previous ROI', () => {
    const original = { widthMm: 80, lengthMm: 30, minHeightMm: -4, maxHeightMm: 5 }
    const repaired = { ...original, minHeightMm: -.1, maxHeightMm: .2 }
    expect(assessmentSourceBounds(original).z[1]).toBeGreaterThan(5)
    expect(assessmentSourceBounds(repaired).z[1]).toBeLessThan(1)
    const selected = assessmentSourceBounds(original, bounds)
    expect(selected).toEqual(bounds); expect(selected.z).not.toBe(bounds.z)
  })
  it('does not allocate a worker for an already aborted request', () => {
    const abort = new AbortController(); abort.abort()
    expect(() => calculateAssessment(source, bounds, DEFAULT_ASSESSMENT_OPTIONS, abort.signal, vi.fn())).toThrow()
    expect(WorkerStub.instances).toHaveLength(0)
  })
  it('keeps source arrays intact and relays progress/result', async () => {
    const onProgress = vi.fn(), abort = new AbortController()
    const promise = calculateAssessment(source, bounds, DEFAULT_ASSESSMENT_OPTIONS, abort.signal, onProgress)
    const worker = WorkerStub.instances[0]
    expect(worker.postMessage).toHaveBeenCalledWith({ source, bounds, options: DEFAULT_ASSESSMENT_OPTIONS })
    worker.onmessage?.({ data: { type: 'progress', progress: .4 } })
    expect(onProgress).toHaveBeenCalledWith(.4)
    worker.onmessage?.({ data: { type: 'result', result: { schemaVersion: 1 } } })
    await expect(promise).resolves.toEqual({ schemaVersion: 1 })
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(source.heights.length).toBe(100)
  })
  it('cancels a job, ignores late results and releases resources', async () => {
    const abort = new AbortController(), progress = vi.fn()
    const promise = calculateAssessment(source, bounds, DEFAULT_ASSESSMENT_OPTIONS, abort.signal, progress)
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    WorkerStub.instances[0].onmessage?.({ data: { type: 'progress', progress: 1 } })
    WorkerStub.instances[0].onmessage?.({ data: { type: 'result', result: {} } })
    await rejection
    expect(progress).not.toHaveBeenCalled(); expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce()
  })
  it('times out a large request and preserves original arrays', async () => {
    const promise = calculateAssessment(source, bounds, DEFAULT_ASSESSMENT_OPTIONS, new AbortController().signal, vi.fn())
    const rejection = expect(promise).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(120001)
    await rejection
    expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce(); expect(source.heights.byteLength).toBe(400)
  })
  it('returns a worker error without manufacturing measurements', async () => {
    const promise = calculateAssessment(source, bounds, DEFAULT_ASSESSMENT_OPTIONS, new AbortController().signal, vi.fn())
    const rejection = expect(promise).rejects.toThrow('有效点不足')
    WorkerStub.instances[0].onmessage?.({ data: { type: 'error', error: '有效点不足' } })
    await rejection
    expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce()
  })
})
