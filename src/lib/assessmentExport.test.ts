import { describe, expect, it } from 'vitest'
import { assessmentComparisonKey, assessmentCsv, assessmentCsvCell } from './assessmentExport'
import { assessZagSurface } from './assessment'
import { DEFAULT_ASSESSMENT_OPTIONS } from './assessmentTypes'
import type { AssessmentRecord } from './assessmentTypes'

function record(): AssessmentRecord {
  const result = assessZagSurface({ heights: new Int32Array(41 * 41), mask: new Uint8Array(44 * 41), maskStride: 44,
    capture: { width: 41, height: 41, xyPitchMm: .25, zUnitMm: 1e-5 } },
  { x: [0, 10], y: [0, 10], z: [-1, 1] }, { ...DEFAULT_ASSESSMENT_OPTIONS, sigmaMm: 0, bowSigmaMm: 1 })
  return { id: 'test', signature: 'test', fileName: '=malicious.csv', captureName: '+formula', captureId: 'capture', sourceKind: 'original', scope: 'XYZ 选区', createdAt: '2026-10-16T00:00:00Z', result }
}

describe('assessment export and comparison definitions', () => {
  it('guards formula labels and escapes quotes, keeps numeric negatives numeric', () => {
    expect(assessmentCsvCell('=1+1')).toBe('"\'=1+1"')
    expect(assessmentCsvCell('  @formula')).toBe('"\'  @formula"')
    expect(assessmentCsvCell(-1.25)).toBe('"-1.25"')
    expect(assessmentCsvCell('a"b')).toBe('"a""b"')
    expect(assessmentCsvCell(null)).toBe('""')
  })
  it('exports units, population, processing and provenance with aligned columns', () => {
    const csv = assessmentCsv([record()])
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('中央跨轴P95_deg')
    expect(lines[1]).toContain('"\'=malicious.csv"')
    expect(lines[1]).toContain('"\'+formula"')
    expect(lines[0].split(',')).toHaveLength(lines[1].split(',' ).length)
  })
  it('flags different processing, region size, reference planes and sampling', () => {
    const a = record(), b = structuredClone(a)
    expect(assessmentComparisonKey(a)).toBe(assessmentComparisonKey(b))
    b.result.options.plane = 'robust'
    expect(assessmentComparisonKey(a)).not.toBe(assessmentComparisonKey(b))
    b.result.options.plane = 'least-squares'; b.sourceKind = 'repaired'
    expect(assessmentComparisonKey(a)).not.toBe(assessmentComparisonKey(b))
    b.sourceKind = 'original'; b.result.bounds.x[1] = 9
    expect(assessmentComparisonKey(a)).not.toBe(assessmentComparisonKey(b))
  })
  it('serializes missing optional metrics as null, never invented zeros or NaN', () => {
    const json = JSON.stringify(record())
    expect(json).not.toContain('NaN'); expect(json).not.toContain('Infinity')
    expect(json).toContain('"summary":null')
  })
})
