import type { RegionBounds } from '../types'
import { validateCalibrationValue, validateZagDimensions } from './fileLimits'
import { validateRegion } from './region'
import type { ZagRegionSource } from './zagRegion'
import type { AngleMetrics, AssessmentOptions, AssessmentResult, CreaseBand, CreaseMetrics, PercentileSummary, SlopeMetrics } from './assessmentTypes'
import { finiteSorted, fitAssessmentPlane, gaussianField, gaussianProfile, heightMetrics, quantileSorted, residualField } from './assessmentMath'

export const ASSESSMENT_MAX_CELLS = 600_000
const degrees = 180 / Math.PI

export function validateAssessmentOptions(o: AssessmentOptions): void {
  for (const [value, min, max] of [
    [o.stepMm, .02, 2], [o.sigmaMm, 0, 2], [o.bowSigmaMm, .5, 20], [o.edgeMarginMm, 0, 20],
    [o.coreHalfWidthMm, .5, 20], [o.shoulderInnerMm, .5, 40], [o.shoulderOuterMm, 1, 60],
    [o.bandWidthMm, .5, 20], [o.angleThresholdDeg, .1, 30],
  ]) if (!Number.isFinite(value) || value < min || value > max) throw new Error('评估参数超出允许范围，请检查输入值')
  if (!['x', 'y'].includes(o.hingeAxis) || !['least-squares', 'robust'].includes(o.plane)
    || (o.hingeCenterMm !== null && !Number.isFinite(o.hingeCenterMm))
    || o.shoulderInnerMm < o.coreHalfWidthMm || o.shoulderOuterMm <= o.shoulderInnerMm) {
    throw new Error('转轴或肩部范围无效：肩部内缘应在中央区域以外，外缘必须大于内缘')
  }
}

function angles(values: number[], threshold: number): AngleMetrics {
  values.sort((a, b) => a - b)
  const p95 = quantileSorted(values, .95)
  return { count: values.length, p50Deg: quantileSorted(values, .5), p95Deg: p95,
    p99Deg: quantileSorted(values, .99), p995Deg: quantileSorted(values, .995), maxDeg: values[values.length - 1],
    aboveThresholdPct: values.filter((v) => v > threshold).length / values.length * 100,
    grade95Pct: p95 < 90 ? Math.tan(p95 / degrees) * 100 : null }
}

/** Relative tangent angles plus exact angle between local and reference normals. */
export function assessmentSlopeMaps(values: Float64Array, nx: number, ny: number, dx: number, dy: number,
  plane: number[], xs: Float64Array, ys: Float64Array, o: AssessmentOptions, center: number) {
  const crossMap = new Float64Array(values.length).fill(NaN), normalMap = crossMap.slice()
  const all = { cross: [] as number[], along: [] as number[], normal: [] as number[], energyCross: 0, energy: 0 }
  const central = { cross: [] as number[], along: [] as number[], normal: [] as number[], energyCross: 0, energy: 0 }
  const [a, b] = plane
  for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const i = y * nx + x
    if (![values[i], values[i - 1], values[i + 1], values[i - nx], values[i + nx]].every(Number.isFinite)) continue
    const gx = (values[i + 1] - values[i - 1]) / (2 * dx), gy = (values[i + nx] - values[i - nx]) / (2 * dy)
    const angleX = (Math.atan(gx) - Math.atan(a)) * degrees, angleY = (Math.atan(gy) - Math.atan(b)) * degrees
    const cross = o.hingeAxis === 'x' ? angleY : angleX, along = o.hingeAxis === 'x' ? angleX : angleY
    const normal = Math.atan2(Math.hypot(gx - a, gy - b, gx * b - gy * a), 1 + gx * a + gy * b) * degrees
    crossMap[i] = cross; normalMap[i] = normal
    const crossGradient = o.hingeAxis === 'x' ? gy - b : gx - a
    const energy = (gx - a) ** 2 + (gy - b) ** 2
    const isCentral = Math.abs((o.hingeAxis === 'x' ? ys[y] : xs[x]) - center) <= o.coreHalfWidthMm
    for (const target of isCentral ? [all, central] : [all]) {
      target.cross.push(Math.abs(cross)); target.along.push(Math.abs(along)); target.normal.push(normal)
      target.energyCross += crossGradient ** 2; target.energy += energy
    }
  }
  const summarize = (v: typeof all): SlopeMetrics | null => v.cross.length ? {
    cross: angles(v.cross, o.angleThresholdDeg), along: angles(v.along, o.angleThresholdDeg), normal: angles(v.normal, o.angleThresholdDeg),
    gradientRms: Math.sqrt(v.energy / v.cross.length), crossEnergyPct: v.energy > 1e-24 ? v.energyCross / v.energy * 100 : null,
  } : null
  return { all: summarize(all), central: summarize(central), crossMap, normalMap }
}

function summary(values: (number | null)[]): PercentileSummary | null {
  const sorted = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b)
  return sorted.length ? { p05: quantileSorted(sorted, .05), p50: quantileSorted(sorted, .5), p95: quantileSorted(sorted, .95) } : null
}

export function assessCrease(values: Float64Array, xs: Float64Array, ys: Float64Array,
  bounds: RegionBounds, o: AssessmentOptions, center: number): CreaseMetrics {
  const along = o.hingeAxis === 'x' ? xs : ys, acrossAll = o.hingeAxis === 'x' ? ys : xs
  const acrossStep = acrossAll[1] - acrossAll[0]
  const take: number[] = []
  for (let i = 0; i < acrossAll.length; i++) if (Math.abs(acrossAll[i] - center) <= o.shoulderOuterMm + 3 * o.sigmaMm + acrossStep) take.push(i)
  const across = take.map((i) => acrossAll[i] - center)
  const extent = bounds[o.hingeAxis], nBands = Math.min(128, Math.max(1, Math.floor((extent[1] - extent[0]) / o.bandWidthMm)))
  const bandSize = (extent[1] - extent[0]) / nBands
  const bands: CreaseBand[] = [], profiles: Float64Array[] = []
  const central = across.map((u, i) => Math.abs(u) <= o.coreHalfWidthMm ? i : -1).filter((i) => i >= 0)
  const shoulderLeft = across.map((u, i) => u <= -o.shoulderInnerMm && u >= -o.shoulderOuterMm ? i : -1).filter((i) => i >= 0)
  const shoulderRight = across.map((u, i) => u >= o.shoulderInnerMm && u <= o.shoulderOuterMm ? i : -1).filter((i) => i >= 0)
  const shoulders = [...shoulderLeft, ...shoulderRight]
  const enoughSpan = (indices: number[]) => indices.length >= 3 && across[indices[indices.length - 1]] - across[indices[0]] >= .5
  if (central.length >= 3 && enoughSpan(shoulderLeft) && enoughSpan(shoulderRight)
    && across[0] <= -o.shoulderOuterMm + acrossStep && across[across.length - 1] >= o.shoulderOuterMm - acrossStep) {
    for (let band = 0; band < nBands; band++) {
      const start = extent[0] + band * bandSize, end = start + bandSize
      const columns: number[] = []
      for (let i = 0; i < along.length; i++) if (along[i] >= start && along[i] < end) columns.push(i)
      if (!columns.length) continue
      let wanted = 0, found = 0
      const raw = Float64Array.from(take, (acrossIndex, j) => {
        const samples: number[] = []
        for (const alongIndex of columns) {
          const value = o.hingeAxis === 'x' ? values[acrossIndex * xs.length + alongIndex] : values[alongIndex * xs.length + acrossIndex]
          if (Math.abs(across[j]) <= o.coreHalfWidthMm || shoulders.includes(j)) {
            wanted++; if (Number.isFinite(value)) found++
          }
          if (Number.isFinite(value)) samples.push(value)
        }
        samples.sort((a, b) => a - b)
        return quantileSorted(samples, .5)
      })
      if (!wanted || found / wanted < .98) continue
      // Remove a line before edge filtering so a perfect tilted profile remains perfect.
      const valid = raw.map((v) => Number.isFinite(v) ? 1 : 0)
      let sw = 0, su = 0, sh = 0, suu = 0, suh = 0
      for (let i = 0; i < raw.length; i++) if (valid[i]) { sw++; su += across[i]; sh += raw[i]; suu += across[i] ** 2; suh += across[i] * raw[i] }
      const baselineSlope = (suh - su * sh / sw) / (suu - su * su / sw)
      const baselineC = (sh - baselineSlope * su) / sw
      const smoothResidual = gaussianProfile(Float64Array.from(raw, (v, i) => v - baselineSlope * across[i] - baselineC), o.sigmaMm / acrossStep)
      const smooth = Float64Array.from(smoothResidual, (v, i) => v + baselineSlope * across[i] + baselineC)
      if (![...central, ...shoulders].every((i) => Number.isFinite(smooth[i]))) continue
      const uMean = shoulders.reduce((s, i) => s + across[i], 0) / shoulders.length
      const hMean = shoulders.reduce((s, i) => s + smooth[i], 0) / shoulders.length
      let numerator = 0, denominator = 0
      for (const i of shoulders) { numerator += (across[i] - uMean) * (smooth[i] - hMean); denominator += (across[i] - uMean) ** 2 }
      const a = numerator / denominator, c = hMean - a * uMean
      const residual = Float64Array.from(smooth, (v, i) => (v - a * across[i] - c) * 1000)
      let minimum = Infinity, maximum = -Infinity, peak = central[0]
      const slope: number[] = []
      for (const i of central) {
        minimum = Math.min(minimum, residual[i]); maximum = Math.max(maximum, residual[i])
        if (Math.abs(residual[i]) > Math.abs(residual[peak])) peak = i
        if (i > 0 && i < smooth.length - 1 && Number.isFinite(smooth[i - 1]) && Number.isFinite(smooth[i + 1])) {
          slope.push(Math.abs((Math.atan((smooth[i + 1] - smooth[i - 1]) / (2 * acrossStep)) - Math.atan(a)) * degrees))
        }
      }
      const sign = residual[peak] >= 0 ? 1 : -1, amplitude = Math.abs(residual[peak]), half = amplitude / 2
      let left = peak, right = peak
      while (left > 0 && Number.isFinite(residual[left - 1]) && residual[left - 1] * sign > half) left--
      while (right < residual.length - 1 && Number.isFinite(residual[right + 1]) && residual[right + 1] * sign > half) right++
      const crossing = (i: number, j: number) => across[i] + (across[j] - across[i]) * (half - residual[i] * sign) / ((residual[j] - residual[i]) * sign)
      const width50 = amplitude > 1e-6 && left > 0 && right < residual.length - 1
        && residual[left - 1] * sign <= half && residual[right + 1] * sign <= half
        ? crossing(right, right + 1) - crossing(left, left - 1) : null
      let area = 0, completeArea = true
      const areaHalfWidth = o.shoulderInnerMm
      for (let i = 0; i < across.length - 1; i++) {
        const lo = Math.max(-areaHalfWidth, across[i]), hi = Math.min(areaHalfWidth, across[i + 1])
        if (lo >= hi) continue
        const v0 = residual[i], v1 = residual[i + 1]
        if (!Number.isFinite(v0) || !Number.isFinite(v1)) { completeArea = false; continue }
        const l = v0 + (v1 - v0) * (lo - across[i]) / acrossStep, r = v0 + (v1 - v0) * (hi - across[i]) / acrossStep
        // Integrate |linear profile| exactly, including any zero crossing.
        area += l * r < 0 ? (hi - lo) * (l * l + r * r) / (2 * (Math.abs(l) + Math.abs(r))) : (hi - lo) * (Math.abs(l) + Math.abs(r)) / 2
      }
      bands.push({ alongMm: (start + end) / 2, coveragePct: found / wanted * 100,
        depthUm: Math.max(0, -minimum), bulgeUm: Math.max(0, maximum), amplitudeUm: Math.max(0, -minimum, maximum),
        slope95Deg: slope.length ? quantileSorted(slope.sort((a, b) => a - b), .95) : null,
        width50Mm: width50, absAreaUmMm: completeArea ? area : null })
      profiles.push(residual)
    }
  }
  const profile: CreaseMetrics['profile'] = { acrossMm: across, medianUm: [], p05Um: [], p95Um: [] }
  for (let i = 0; i < across.length; i++) {
    const v = profiles.map((p) => p[i]).filter(Number.isFinite).sort((a, b) => a - b)
    profile.medianUm.push(v.length ? quantileSorted(v, .5) : null)
    profile.p05Um.push(v.length ? quantileSorted(v, .05) : null)
    profile.p95Um.push(v.length ? quantileSorted(v, .95) : null)
  }
  return { totalBands: nBands, validBands: bands.length, bands, profile, summary: bands.length ? {
    depthUm: summary(bands.map((b) => b.depthUm))!, bulgeUm: summary(bands.map((b) => b.bulgeUm))!,
    amplitudeUm: summary(bands.map((b) => b.amplitudeUm))!, slope95Deg: summary(bands.map((b) => b.slope95Deg)),
    width50Mm: summary(bands.map((b) => b.width50Mm)), absAreaUmMm: summary(bands.map((b) => b.absAreaUmMm)),
  } : null }
}

export function assessZagSurface(source: ZagRegionSource, requestedBounds: RegionBounds,
  o: AssessmentOptions, progress?: (value: number) => void): AssessmentResult {
  validateRegion(requestedBounds); validateAssessmentOptions(o)
  const { width, height, xyPitchMm: pitch, zUnitMm: unit } = source.capture
  const dimensions = validateZagDimensions(width, height)
  validateCalibrationValue(pitch, 'XY '); validateCalibrationValue(unit, 'Z ')
  if (source.heights.length !== dimensions.pixels || source.maskStride !== dimensions.maskStride || source.mask.length !== dimensions.maskBytes) {
    throw new Error('评估源数据尺寸不匹配，请重新打开 ZAG')
  }
  const bounds: RegionBounds = {
    x: [Math.max(0, requestedBounds.x[0]) + o.edgeMarginMm, Math.min((width - 1) * pitch, requestedBounds.x[1]) - o.edgeMarginMm],
    y: [Math.max(0, requestedBounds.y[0]) + o.edgeMarginMm, Math.min((height - 1) * pitch, requestedBounds.y[1]) - o.edgeMarginMm],
    z: [...requestedBounds.z],
  }
  validateRegion(bounds)
  const spanX = bounds.x[1] - bounds.x[0], spanY = bounds.y[1] - bounds.y[0]
  let step = Math.max(o.stepMm, pitch, o.bowSigmaMm / 80, o.sigmaMm / 80)
  let nx = Math.floor(spanX / step + 1e-9), ny = Math.floor(spanY / step + 1e-9)
  if (nx * ny > ASSESSMENT_MAX_CELLS) {
    step *= Math.sqrt(nx * ny / ASSESSMENT_MAX_CELLS) * 1.001
    nx = Math.floor(spanX / step); ny = Math.floor(spanY / step)
  }
  if (nx < 3 || ny < 3) throw new Error('选区过窄，至少需要 3×3 个分析网格；请扩大区域或减小采样间距')
  const dx = spanX / nx, dy = spanY / ny
  const xs = Float64Array.from({ length: nx }, (_, i) => bounds.x[0] + (i + .5) * dx)
  const ys = Float64Array.from({ length: ny }, (_, i) => bounds.y[0] + (i + .5) * dy)
  const raw = new Float64Array(nx * ny).fill(NaN)
  const sourcePoints: AssessmentResult['sourcePoints'] = { total: 0, valid: 0, selected: 0, minMm: null, maxMm: null }
  for (let y = Math.ceil(bounds.y[0] / pitch); y <= Math.floor(bounds.y[1] / pitch); y++) {
    for (let x = Math.ceil(bounds.x[0] / pitch); x <= Math.floor(bounds.x[1] / pitch); x++) {
      sourcePoints.total++
      if (source.mask[y * source.maskStride + x] === 2) continue
      sourcePoints.valid++
      const value = source.heights[y * width + x] * unit
      if (value < bounds.z[0] || value > bounds.z[1]) continue
      sourcePoints.selected++; sourcePoints.minMm = Math.min(sourcePoints.minMm ?? Infinity, value); sourcePoints.maxMm = Math.max(sourcePoints.maxMm ?? -Infinity, value)
    }
  }
  let rawValid = 0
  for (let y = 0; y < ny; y++) {
    const gy = ys[y] / pitch, y0 = Math.floor(gy), y1 = Math.min(height - 1, y0 + 1), fy = gy - y0
    for (let x = 0; x < nx; x++) {
      const gx = xs[x] / pitch, x0 = Math.floor(gx), x1 = Math.min(width - 1, x0 + 1), fx = gx - x0
      let value = 0, valid = true
      for (const [cx, cy, weight] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
        if (weight <= 1e-12) continue
        if (source.mask[cy * source.maskStride + cx] === 2) { valid = false; break }
        value += source.heights[cy * width + cx] * unit * weight
      }
      if (valid && value >= bounds.z[0] && value <= bounds.z[1]) { raw[y * nx + x] = value; rawValid++ }
    }
  }
  if (!rawValid) throw new Error('当前 XYZ 范围内没有有效表面，请检查 Z 范围或扩大选区')
  progress?.(.15)
  const robust = o.plane === 'robust', rawPlane = fitAssessmentPlane(raw, xs, ys, robust)
  const verticalResidual = residualField(raw, xs, ys, rawPlane, false)
  const rawMetrics = heightMetrics(residualField(raw, xs, ys, rawPlane))
  const makeSurface = (sigma: number) => {
    const smoothed = gaussianField(verticalResidual, nx, ny, sigma / dx, sigma / dy)
    return Float64Array.from(smoothed, (v, i) => v + rawPlane[0] * xs[i % nx] + rawPlane[1] * ys[Math.floor(i / nx)] + rawPlane[2])
  }
  const surface = makeSurface(o.sigmaMm), plane = fitAssessmentPlane(surface, xs, ys, robust)
  const residual = residualField(surface, xs, ys, plane), surfaceMetrics = heightMetrics(residual)
  progress?.(.4)
  const acrossBounds = bounds[o.hingeAxis === 'x' ? 'y' : 'x']
  const center = o.hingeCenterMm ?? (acrossBounds[0] + acrossBounds[1]) / 2
  const centralResidual = Float64Array.from(residual, (v, i) => Math.abs((o.hingeAxis === 'x' ? ys[Math.floor(i / nx)] : xs[i % nx]) - center) <= o.coreHalfWidthMm ? v : NaN)
  const slope = assessmentSlopeMaps(surface, nx, ny, dx, dy, plane, xs, ys, o, center)
  progress?.(.55)
  const broad = gaussianField(residual, nx, ny, o.bowSigmaMm / dx, o.bowSigmaMm / dy), broadValues = finiteSorted(broad)
  const bow98 = broadValues.length ? (quantileSorted(broadValues, .99) - quantileSorted(broadValues, .01)) * 1000 : null
  progress?.(.75)
  const crease = assessCrease(raw, xs, ys, bounds, o, center)
  const warnings: string[] = []
  if (sourcePoints.valid > sourcePoints.selected) warnings.push('Z 选区裁掉了部分高度，结果可能偏低。请勿直接与完整高度范围比较。')
  if (surfaceMetrics.count / raw.length < .98) warnings.push('有效覆盖率低于 98%。缺测不填零、缺测邻域不参与统计；请检查热图空白。')
  if (!crease.validBands) warnings.push('折痕指标不可用：中央或两侧参考区不完整。请扩大选区或调整转轴及参考区；平整度仍可计算。')
  else if (crease.validBands < crease.totalBands) warnings.push('部分位置缺测或缺少两侧参考区，折痕结果仅包含可用位置。')
  if (Math.abs(dx - o.stepMm) > .005 || Math.abs(dy - o.stepMm) > .005) warnings.push('已按扫描分辨率和 60 万格上限调整计算间距。细小尖刺可能漏算。')
  if (o.hingeCenterMm === null) warnings.push('暂用区域中线作为转轴，请确认位置。等面积不代表各机型已对齐。')
  if (o.sigmaMm === 0) warnings.push('未滤波：噪声和尖刺会更影响坡角与极值。')
  const mapNx = Math.min(200, nx), mapNy = Math.min(160, ny)
  const maps: AssessmentResult['maps'] = { nx: mapNx, ny: mapNy, residualUm: [], crossDeg: [], normalDeg: [] }
  for (let y = 0; y < mapNy; y++) for (let x = 0; x < mapNx; x++) {
    const i = Math.min(ny - 1, Math.floor((y + .5) / mapNy * ny)) * nx + Math.min(nx - 1, Math.floor((x + .5) / mapNx * nx))
    maps.residualUm.push(Number.isFinite(residual[i]) ? residual[i] * 1000 : null)
    maps.crossDeg.push(Number.isFinite(slope.crossMap[i]) ? slope.crossMap[i] : null)
    maps.normalDeg.push(Number.isFinite(slope.normalMap[i]) ? slope.normalMap[i] : null)
  }
  const sensitivity: AssessmentResult['sensitivity'] = []
  if (o.sensitivity) for (const sigmaMm of [.15, .5]) {
    const h = makeSurface(sigmaMm), p = fitAssessmentPlane(h, xs, ys, robust)
    const m = heightMetrics(residualField(h, xs, ys, p))
    const s = assessmentSlopeMaps(h, nx, ny, dx, dy, p, xs, ys, o, center)
    sensitivity.push({ sigmaMm, rmsUm: m.rmsUm, f98Um: m.f98Um, cross95Deg: s.central?.cross.p95Deg ?? null })
  }
  progress?.(1)
  return { schemaVersion: 1, bounds, options: { ...o },
    grid: { nx, ny, dxMm: dx, dyMm: dy, rawCoveragePct: rawValid / raw.length * 100,
      coveragePct: surfaceMetrics.count / raw.length * 100, eligibleAreaMm2: surfaceMetrics.count * dx * dy },
    sourcePoints, plane, planeTiltDeg: Math.atan(Math.hypot(plane[0], plane[1])) * degrees,
    raw: rawMetrics, surface: surfaceMetrics,
    central: finiteSorted(centralResidual).length ? heightMetrics(centralResidual) : null,
    bow98Um: bow98, slopes: slope.all, centralSlopes: slope.central, crease, maps, sensitivity, warnings }
}
