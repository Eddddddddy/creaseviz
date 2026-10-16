import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AdvancedSettings from './AdvancedSettings'
import AssessmentWorkspace from './AssessmentWorkspace'
import ObjExportPanel from './ObjExportPanel'
import SpikeRemovalPanel from './SpikeRemovalPanel'
import { DEFAULT_ASSESSMENT_OPTIONS, type AssessmentOptions } from '../lib/assessmentTypes'
import { DEFAULT_SPIKE_OPTIONS } from '../lib/spikeRemoval'
import type { ViewerModel } from '../types'

const noop = () => {}

function detailsContent(html: string): string {
  const match = html.match(/<details\b[^>]*>([\s\S]*?)<\/details>/)
  expect(match).not.toBeNull()
  return match![1]
}

function expectCollapsed(html: string) {
  const tags = [...html.matchAll(/<details\b([^>]*)>/g)]
  expect(tags.length).toBeGreaterThan(0)
  for (const tag of tags) expect(tag[1]).not.toMatch(/\bopen(?:=|\s|$)/)
}

function renderAssessment(options: Partial<AssessmentOptions> = {}) {
  return renderToStaticMarkup(<AssessmentWorkspace
    captures={[]} busy={false} regionEnabled={false} onRegionEnabled={noop} onRegion={noop}
    onFocusRegion={noop} onCapture={noop} getSourceModel={() => undefined}
    session={{ options: { ...DEFAULT_ASSESSMENT_OPTIONS, ...options }, scope: 'selection', source: 'current', comparisons: [] }}
    onSession={noop} onBack={noop} onOpenFile={noop}
  />)
}

function renderSpike(thresholdUm = DEFAULT_SPIKE_OPTIONS.thresholdUm) {
  return renderToStaticMarkup(<SpikeRemovalPanel
    spikeOptions={{ ...DEFAULT_SPIKE_OPTIONS, thresholdUm }} onSpikeOptions={noop}
    spikeEnabled={false} spikeProcessing={false} spikeProgress={0} spikeDisabled={false}
    onRepairSpikes={noop} onToggleSpikes={noop} onCancelSpikes={noop}
  />)
}

function renderObj(scale: 'true' | 'display' = 'true') {
  const model = { kind: 'zag', hasSourceData: true } as ViewerModel
  return renderToStaticMarkup(<ObjExportPanel
    model={model} objScaleMode={scale} objDetail="high" objExporting={false} objExportProgress={0}
    regionEnabled={true} regionDisabled={false} scaleX={1} scaleY={1} scaleZ={10}
    onObjScaleMode={noop} onObjDetail={noop} onExportObj={noop}
  />)
}

describe('progressive disclosure and usable defaults', () => {
  it('starts closed, has an accessible name, and keeps child controls mounted', () => {
    const html = renderToStaticMarkup(<AdvancedSettings label="测试高级设置" hint="推荐参数"><input aria-label="保留的数值" defaultValue={0} /></AdvancedSettings>)
    expectCollapsed(html)
    expect(html).toContain('aria-label="测试高级设置"')
    expect(detailsContent(html)).toContain('value="0"')
  })

  it('keeps one-click repair outside advanced settings with safe defaults', () => {
    const html = renderSpike()
    expectCollapsed(html)
    expect(html).toContain('20 µm · 0.3 mm · 仅向上尖刺')
    expect(detailsContent(html)).toContain('aria-label="去尖刺高度阈值"')
    expect(detailsContent(html)).not.toContain('计算并应用去尖刺')
    expect(html).toContain('计算并应用去尖刺')
  })

  it('does not disguise custom spike parameters as defaults when collapsed', () => {
    const html = renderSpike(35)
    expect(html).toContain('自定义参数')
    expect(html).toContain('35 µm · 0.3 mm')
    expectCollapsed(html)
  })

  it('keeps true-scale high-quality OBJ download outside the menu', () => {
    const html = renderObj()
    expectCollapsed(html)
    expect(html).toContain('真实比例 1:1:1')
    expect(html).toContain('高精度 · 自动控制文件大小')
    expect(detailsContent(html)).toContain('aria-label="OBJ 导出精度"')
    expect(detailsContent(html)).not.toContain('下载选区 OBJ')
  })

  it('labels non-physical OBJ scale as custom even when the controls are hidden', () => {
    const html = renderObj('display')
    expect(html).toContain('已自定义')
    expect(html).toContain('<strong>当前显示比例</strong>')
  })

  it('keeps axis selection and the assessment action outside the scientific parameters', () => {
    const html = renderAssessment()
    expectCollapsed(html)
    expect(html).toContain('推荐参数 · 可直接评估')
    const advanced = detailsContent(html)
    for (const label of ['目标分析间距', '形貌滤波尺度', '肩部内缘距离', '沿轴分带宽度', '坡角超限阈值']) {
      expect(advanced).toContain(`aria-label="${label}"`)
    }
    expect(advanced).not.toContain('aria-label="转轴方向"')
    expect(advanced).not.toContain('开始评估')
    expect(html).toContain('开始评估')
    expect(advanced).toContain('value="0.1"')
    expect(advanced).toContain('<option value="0.25" selected="">')
  })

  it('allows either explicitly selected hinge axis with the recommended method', () => {
    expect(renderAssessment({ hingeAxis: 'y' })).toContain('推荐参数 · 可直接评估')
  })

  it.each([
    { stepMm: .2 }, { sigmaMm: .5 }, { bowSigmaMm: 8 }, { edgeMarginMm: 5 }, { plane: 'robust' },
    { hingeCenterMm: 20 }, { coreHalfWidthMm: 5 }, { shoulderInnerMm: 9 }, { shoulderOuterMm: 16 },
    { bandWidthMm: 4 }, { angleThresholdDeg: 2 }, { sensitivity: true },
  ] satisfies Partial<AssessmentOptions>[])('reports custom hidden assessment settings: %j', (options) => {
    expect(renderAssessment(options)).toContain('自定义参数 · 收起后仍生效')
  })
})
