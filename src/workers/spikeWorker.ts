/// <reference lib="webworker" />
import { removeZagSpikes, type SpikeRemovalOptions } from '../lib/spikeRemoval'
import type { ZagRegionSource } from '../lib/zagRegion'

self.onmessage = (event: MessageEvent<{ source: ZagRegionSource; options: SpikeRemovalOptions }>) => {
  try {
    const result = removeZagSpikes(event.data.source, event.data.options,
      (progress) => self.postMessage({ type: 'progress', progress }))
    self.postMessage({ type: 'result', ...result }, { transfer: [result.heights.buffer] })
  } catch (cause) {
    self.postMessage({ type: 'error', error: cause instanceof Error ? cause.message : '去尖刺失败' })
  }
}

export {}
