import type { RegionBounds } from '../types'
import type { EqualAreaSize } from './assessmentRegion'

export interface AssessmentOptions {
  stepMm: number
  sigmaMm: number
  bowSigmaMm: number
  edgeMarginMm: number
  plane: 'least-squares' | 'robust'
  hingeAxis: 'x' | 'y'
  hingeCenterMm: number | null
  coreHalfWidthMm: number
  shoulderInnerMm: number
  shoulderOuterMm: number
  bandWidthMm: number
  angleThresholdDeg: number
  sensitivity: boolean
}

export const DEFAULT_ASSESSMENT_OPTIONS: AssessmentOptions = {
  stepMm: 0.1, sigmaMm: 0.25, bowSigmaMm: 5, edgeMarginMm: 0, plane: 'least-squares',
  hingeAxis: 'x', hingeCenterMm: null, coreHalfWidthMm: 6, shoulderInnerMm: 8,
  shoulderOuterMm: 15, bandWidthMm: 5, angleThresholdDeg: 1, sensitivity: false,
}

export interface HeightMetrics {
  count: number
  rmsUm: number
  meanAbsUm: number
  pvUm: number
  f98Um: number
  f90Um: number
  peakUm: number
  pitUm: number
  skewness: number | null
  kurtosis: number | null
}

export interface AngleMetrics {
  count: number
  p50Deg: number
  p95Deg: number
  p99Deg: number
  p995Deg: number
  maxDeg: number
  aboveThresholdPct: number
  grade95Pct: number | null
}

export interface SlopeMetrics {
  cross: AngleMetrics
  along: AngleMetrics
  normal: AngleMetrics
  gradientRms: number
  crossEnergyPct: number | null
}

export interface CreaseBand {
  alongMm: number
  coveragePct: number
  depthUm: number
  bulgeUm: number
  amplitudeUm: number
  slope95Deg: number | null
  width50Mm: number | null
  absAreaUmMm: number | null
}

export interface PercentileSummary { p05: number; p50: number; p95: number }

export interface CreaseMetrics {
  validBands: number
  totalBands: number
  bands: CreaseBand[]
  summary: {
    depthUm: PercentileSummary; bulgeUm: PercentileSummary; amplitudeUm: PercentileSummary
    slope95Deg: PercentileSummary | null; width50Mm: PercentileSummary | null; absAreaUmMm: PercentileSummary | null
  } | null
  profile: { acrossMm: number[]; medianUm: (number | null)[]; p05Um: (number | null)[]; p95Um: (number | null)[] }
}

export interface AssessmentResult {
  schemaVersion: 1
  bounds: RegionBounds
  options: AssessmentOptions
  grid: { nx: number; ny: number; dxMm: number; dyMm: number; rawCoveragePct: number; coveragePct: number; eligibleAreaMm2: number }
  sourcePoints: { total: number; valid: number; selected: number; minMm: number | null; maxMm: number | null }
  plane: [number, number, number]
  planeTiltDeg: number
  raw: HeightMetrics
  surface: HeightMetrics
  central: HeightMetrics | null
  bow98Um: number | null
  slopes: SlopeMetrics | null
  centralSlopes: SlopeMetrics | null
  crease: CreaseMetrics
  maps: { nx: number; ny: number; residualUm: (number | null)[]; crossDeg: (number | null)[]; normalDeg: (number | null)[] }
  sensitivity: { sigmaMm: number; rmsUm: number; f98Um: number; cross95Deg: number | null }[]
  warnings: string[]
}

export interface AssessmentRecord {
  id: string
  signature: string
  fileName: string
  captureName: string
  captureId: string
  sourceKind: 'original' | 'repaired'
  repairNote?: string
  createdAt: string
  scope: string
  result: AssessmentResult
}

export interface AssessmentSession {
  options: AssessmentOptions
  scope: 'selection' | 'full'
  source: 'current' | 'original'
  equalArea?: EqualAreaSize
  result?: AssessmentRecord
  comparisons: AssessmentRecord[]
}
