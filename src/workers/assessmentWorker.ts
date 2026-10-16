/// <reference lib="webworker" />
import { assessZagSurface } from '../lib/assessment'
import type { AssessmentOptions } from '../lib/assessmentTypes'
import type { ZagRegionSource } from '../lib/zagRegion'
import type { RegionBounds } from '../types'

self.onmessage = (event: MessageEvent<{ source: ZagRegionSource; bounds: RegionBounds; options: AssessmentOptions }>) => {
  try {
    const { source, bounds, options } = event.data
    const result = assessZagSurface(source, bounds, options, (progress) => self.postMessage({ type: 'progress', progress }))
    self.postMessage({ type: 'result', result })
  } catch (cause) {
    self.postMessage({ type: 'error', error: cause instanceof Error ? cause.message : '屏幕评估失败' })
  }
}

export {}
