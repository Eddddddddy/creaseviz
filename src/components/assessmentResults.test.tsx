import { renderToStaticMarkup } from 'react-dom/server'
import { BufferGeometry } from 'three'
import { describe, expect, it, vi } from 'vitest'
import AssessmentWorkspace from './AssessmentWorkspace'
import AssessmentResultDetails from './AssessmentResultDetails'
import RegionSelection from './RegionSelection'
import { assessZagSurface } from '../lib/assessment'
import { assessmentSignature, createEqualAreaRegion, DEFAULT_EQUAL_AREA_SIZE } from '../lib/assessmentRegion'
import { DEFAULT_ASSESSMENT_OPTIONS as options, type AssessmentRecord } from '../lib/assessmentTypes'
import type { ViewerModel } from '../types'

const noop = () => {}
const model: ViewerModel = {
  kind: 'zag', fileName: 'synthetic.zag', label: '模拟记录', geometry: new BufferGeometry(),
  palette: new Uint8Array(), widthMm: 120, lengthMm: 50, minHeightMm: .2, maxHeightMm: .2,
  suggestedMinMm: .199, suggestedMaxMm: .201, triangleCount: 0, originalPointCount: 0,
  renderedPointCount: 0, sampleStep: 1, heightAxis: [0, 0, 1], rotationX: 0, scaleOrder: 'zag',
  crossSections: [], crossSectionX: new Float32Array(), hasSourceData: true,
}
const bounds = createEqualAreaRegion(model, DEFAULT_EQUAL_AREA_SIZE, 'x')
const result = assessZagSurface({ capture: { width: 241, height: 101, xyPitchMm: .5, zUnitMm: 1e-6 },
  heights: new Int32Array(241 * 101).fill(200000), mask: new Uint8Array(244 * 101), maskStride: 244 }, bounds, options)
const record: AssessmentRecord = { id: 'test', signature: assessmentSignature(model.geometry.uuid, bounds, options, 'current'),
  fileName: model.fileName, captureId: 'test', captureName: model.label, sourceKind: 'original',
  createdAt: '2026-01-01T00:00:00Z', scope: 'XYZ 选区', result }

function render(recordOverride: AssessmentRecord = record, busy = false) {
  return renderToStaticMarkup(<AssessmentWorkspace
    model={model} captures={[]} busy={busy} regionEnabled={true} region={bounds}
    onRegionEnabled={noop} onRegion={noop} onFocusRegion={noop} onCapture={noop} getSourceModel={() => model}
    session={{ options, scope: 'selection', source: 'current', result: recordOverride, comparisons: [] }}
    onSession={noop} onBack={noop} onOpenFile={noop}
  />)
}

describe('compact assessment result defaults', () => {
  it('defers detail renderers completely until the user expands the disclosure', () => {
    const children = vi.fn(() => <div>昂贵图表</div>)
    const html = renderToStaticMarkup(<AssessmentResultDetails title="详细结果" hint="按需展开">{children}</AssessmentResultDetails>)
    expect(children).not.toHaveBeenCalled()
    expect(html).not.toContain('昂贵图表')
    expect(html).not.toMatch(/<details[^>]*\bopen=/)
    expect(html).toContain('aria-label="详细结果"')
  })
  it('shows exactly four core values, source, nominal area and coverage', () => {
    const html = render()
    const hero = html.match(/class="assessment-hero-metrics">([\s\S]*?)<div class="assessment-compact-scope"/)![1]
    expect((hero.match(/<strong>/g) ?? []).length).toBe(4)
    for (const label of ['整体平整度 RMS', '主要高低差 F98', '中央折痕起伏', '中央坡角 P95']) expect(hero).toContain(label)
    expect(html).toContain('2400.00'); expect(html).toContain('有效覆盖')
    expect(html).toContain('原始数据')
  })
  it('does not mount detailed tables, charts or formulas by default, and does not change export data', () => {
    const before = JSON.stringify(record)
    const html = render()
    expect(html).toContain('aria-label="详细指标与图表"')
    expect(html).toContain('aria-label="计算说明与范围"')
    expect(html).not.toContain('<table'); expect(html).not.toContain('<canvas')
    expect(html).not.toContain('Ssk 型偏斜度'); expect(html).not.toContain('平面为 z=ax')
    expect(JSON.stringify(record)).toBe(before)
  })
  it('keeps data quality warnings and repaired-source caveats visible outside folded details', () => {
    const html = render({ ...record, repairNote: '修复参数示意', result: { ...result, warnings: ['模拟缺测警告'] } })
    expect(html).toContain('模拟缺测警告'); expect(html).toContain('修复参数示意')
  })
  it('uses unavailable markers instead of zero for missing central crease and slope metrics', () => {
    const html = render({ ...record, result: { ...result, centralSlopes: null, crease: { ...result.crease, summary: null } } })
    expect(html).toContain('中央折痕起伏</span><strong>—<small>µm')
    expect(html).toContain('中央坡角 P95</span><strong>—<small>°')
  })
  it('exposes a one-click equal-area workflow and keeps manual assessment available', () => {
    const html = render()
    expect(html).toContain('自动取同面积区域并评估')
    expect(html).toContain('重新评估')
    expect(html).toContain('aria-label="自动取区高级设置"')
  })
  it('disables both result downloads while a new capture is loading', () => {
    const header = render(record, true).match(/<header[\s\S]*?<\/header>/)![0]
    expect((header.match(/disabled=""/g) ?? []).length).toBe(2)
    expect(header).toContain('结果 JSON'); expect(header).toContain('指标 CSV')
  })
  it('offers the same-area shortcut in 3D even before manual selection is enabled', () => {
    const html = renderToStaticMarkup(<RegionSelection model={model} enabled={false} bounds={bounds} disabled={false}
      onEnabled={noop} onBounds={noop} onFocus={noop}
      equalAreaAction={{ size: { alongMm: 40, acrossMm: 20 }, hingeAxis: 'y', sourceLabel: '原始 ZAG', onSelect: noop }} />)
    expect(html).toContain('选取同面积评估区域')
    expect(html).toContain('40 × 20 mm（沿轴 × 跨轴）· 转轴沿 Y')
    expect(html).toContain('原始 ZAG · 自动聚焦')
    expect(html.indexOf('选取同面积评估区域')).toBeLessThan(html.indexOf('<fieldset hidden=""'))
  })
  it('displays rejected same-area selection errors instead of claiming a smaller area', () => {
    const html = renderToStaticMarkup(<RegionSelection model={model} enabled={true} bounds={bounds} disabled={true}
      onEnabled={noop} onBounds={noop} onFocus={noop}
      equalAreaAction={{ size: DEFAULT_EQUAL_AREA_SIZE, hingeAxis: 'x', sourceLabel: '原始高度', error: '尺寸不足，未缩小选区', onSelect: noop }} />)
    expect(html).toContain('role="alert">尺寸不足，未缩小选区')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>选取同面积评估区域/)
  })
})
