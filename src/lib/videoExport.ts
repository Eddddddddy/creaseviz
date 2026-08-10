import type { ExportQuality } from '../types'

export const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const

export const VIDEO_LIMITS = {
  maxDimension: 7_680,
  maxPixels: 7_680 * 4_320,
  maxDurationSeconds: 10 * 60,
  maxBitrate: 120_000_000,
} as const

export function animationDurationSeconds(totalAngle: number, speedDegreesPerSecond: number): number {
  if (!Number.isFinite(totalAngle) || !Number.isFinite(speedDegreesPerSecond) || speedDegreesPerSecond <= 0) return 0
  return Math.abs(totalAngle) / speedDegreesPerSecond
}

export function formatClock(totalSeconds: number, includeTenths = false): string {
  const safeSeconds = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0)
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = Math.floor(safeSeconds % 60)
  if (!includeTenths) return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  const tenths = Math.floor((safeSeconds % 1) * 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`
}

export function supportedVideoMimeType(
  isTypeSupported: ((mimeType: string) => boolean) | undefined,
): string | undefined {
  if (!isTypeSupported) return undefined
  return VIDEO_MIME_CANDIDATES.find((candidate) => isTypeSupported(candidate))
}

export function videoBitrate(
  width: number,
  height: number,
  fps: number,
  quality: ExportQuality,
): number {
  const qualityFactor: Record<ExportQuality, number> = {
    standard: 0.085,
    high: 0.14,
    maximum: 0.22,
  }
  return Math.round(Math.min(VIDEO_LIMITS.maxBitrate, Math.max(2_500_000, width * height * fps * qualityFactor[quality])))
}

export function validateRecordingSettings(width: number, height: number, fps: number, durationSeconds: number): string | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) return '视频分辨率无效'
  if (width > VIDEO_LIMITS.maxDimension || height > VIDEO_LIMITS.maxDimension) return '视频单边尺寸不能超过 7680 px'
  if (width * height > VIDEO_LIMITS.maxPixels) return '视频总像素不能超过 8K（7680 × 4320）'
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) return '视频帧率必须在 1–60 FPS 之间'
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return '录制时长无效'
  if (durationSeconds > VIDEO_LIMITS.maxDurationSeconds) return '单段录制最长为 10 分钟，请提高转速或减小总角度'
  return undefined
}

export function safeVideoFileName(modelLabel: string, width: number, height: number, fps: number, date = new Date()): string {
  const base = modelLabel
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'crease-scan'
  const timestamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('')
  return `${base}-${width}x${height}-${fps}fps-${timestamp}.webm`
}
