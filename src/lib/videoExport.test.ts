import { describe, expect, it } from 'vitest'
import {
  animationDurationSeconds,
  formatClock,
  safeVideoFileName,
  supportedVideoMimeType,
  validateRecordingSettings,
  VIDEO_LIMITS,
  videoBitrate,
} from './videoExport'

describe('video export helpers', () => {
  it('derives animation duration from angle and speed', () => {
    expect(animationDurationSeconds(360, 12)).toBe(30)
    expect(animationDurationSeconds(90, 0)).toBe(0)
  })

  it('formats transport time', () => {
    expect(formatClock(65.94)).toBe('01:05')
    expect(formatClock(65.94, true)).toBe('01:05.9')
  })

  it('selects the first supported WebM codec', () => {
    expect(supportedVideoMimeType((type) => type.includes('vp8'))).toBe('video/webm;codecs=vp8')
    expect(supportedVideoMimeType(() => false)).toBeUndefined()
  })

  it('scales bitrate with output settings and quality', () => {
    expect(videoBitrate(1920, 1080, 30, 'high')).toBeGreaterThan(videoBitrate(1280, 720, 30, 'high'))
    expect(videoBitrate(1920, 1080, 30, 'maximum')).toBeGreaterThan(videoBitrate(1920, 1080, 30, 'standard'))
    expect(videoBitrate(7680, 4320, 60, 'maximum')).toBe(VIDEO_LIMITS.maxBitrate)
  })

  it('bounds recording allocations and duration', () => {
    expect(validateRecordingSettings(3840, 2160, 60, 600)).toBeUndefined()
    expect(validateRecordingSettings(7680, 7680, 30, 10)).toMatch(/总像素/)
    expect(validateRecordingSettings(1920, 1080, 30, 601)).toMatch(/10 分钟/)
  })

  it('creates a filesystem-safe deterministic filename', () => {
    const name = safeVideoFileName('VR scan.zag', 1920, 1080, 30, new Date(2026, 7, 10, 14, 5, 9))
    expect(name).toBe('VR-scan-1920x1080-30fps-20260810-140509.webm')
  })
})
