import type { AssessmentRecord } from './assessmentTypes'

/** Guard spreadsheet formula interpretation in source-provided labels. */
export function assessmentCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  const safe = typeof value === 'string' && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

export function assessmentCsv(records: AssessmentRecord[]): string {
  const keys = ['文件', '采集记录', '数据', '计算时间', 'X起点mm', 'X终点mm', 'Y起点mm', 'Y终点mm', 'Z起点mm', 'Z终点mm',
    '间距Xmm', '间距Ymm', '滤波sigma_mm', '整体翘曲sigma_mm', '基准', '转轴方向', '转轴位置mm', '中央半宽mm', '肩部内缘mm', '肩部外缘mm', '分带宽度mm',
    '有效覆盖率pct', 'RMS_um', '平均绝对偏差_um', 'PV_um', 'F98_um', 'F90_um', 'Sp_um', 'Sv_um', 'Ssk', 'Sku', 'Bow98_um',
    '中央RMS_um', '中央F98_um', '跨轴P95_deg', '沿轴P95_deg', '法向P95_deg', '中央跨轴P95_deg', '中央跨轴P99_deg',
    '超限角度deg', '跨轴超限pct', 'Sdq', '跨轴能量pct', '深度P50_um', '深度P95_um', '隆起P50_um', '隆起P95_um', '半高宽P50_mm', '截面积P50_um_mm', '有效分带数', '备注']
  const rows = records.map((record) => {
    const r = record.result, o = r.options, s = r.crease.summary
    return [record.fileName, record.captureName, record.sourceKind, record.createdAt, ...r.bounds.x, ...r.bounds.y, ...r.bounds.z,
      r.grid.dxMm, r.grid.dyMm, o.sigmaMm, o.bowSigmaMm, o.plane, o.hingeAxis, o.hingeCenterMm ?? '区域中线', o.coreHalfWidthMm, o.shoulderInnerMm, o.shoulderOuterMm, o.bandWidthMm,
      r.grid.coveragePct, r.surface.rmsUm, r.surface.meanAbsUm, r.surface.pvUm, r.surface.f98Um, r.surface.f90Um, r.surface.peakUm, r.surface.pitUm, r.surface.skewness, r.surface.kurtosis, r.bow98Um,
      r.central?.rmsUm, r.central?.f98Um, r.slopes?.cross.p95Deg, r.slopes?.along.p95Deg, r.slopes?.normal.p95Deg, r.centralSlopes?.cross.p95Deg, r.centralSlopes?.cross.p99Deg,
      o.angleThresholdDeg, r.slopes?.cross.aboveThresholdPct, r.slopes?.gradientRms, r.slopes?.crossEnergyPct, s?.depthUm.p50, s?.depthUm.p95, s?.bulgeUm.p50, s?.bulgeUm.p95, s?.width50Mm?.p50, s?.absAreaUmMm?.p50, r.crease.validBands,
      [record.repairNote, ...r.warnings].filter(Boolean).join('；')]
  })
  return '\uFEFF' + [keys, ...rows].map((row) => row.map(assessmentCsvCell).join(',')).join('\r\n')
}

export function downloadAssessment(records: AssessmentRecord[], format: 'json' | 'csv'): void {
  const blob = new Blob([format === 'json' ? JSON.stringify({ schema: 'creaseviz-assessment-v1', records }, null, 2) : assessmentCsv(records)],
    { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = `creaseviz-assessment-${Date.now()}.${format}`
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 15_000)
}

/** Geometry dimensions and method must match; this does NOT certify alignment. */
export function assessmentComparisonKey(record: AssessmentRecord): string {
  const r = record.result, o = r.options
  const across = r.bounds[o.hingeAxis === 'x' ? 'y' : 'x']
  return JSON.stringify({ width: Number((r.bounds.x[1] - r.bounds.x[0]).toFixed(3)),
    height: Number((r.bounds.y[1] - r.bounds.y[0]).toFixed(3)), source: record.sourceKind, repair: record.repairNote,
    options: { ...o, sensitivity: false, hingeCenterMm: o.hingeCenterMm === null ? null : Number((o.hingeCenterMm - (across[0] + across[1]) / 2).toFixed(3)) },
    dx: Number(r.grid.dxMm.toFixed(5)), dy: Number(r.grid.dyMm.toFixed(5)), zClipped: r.sourcePoints.selected < r.sourcePoints.valid })
}
