import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowLeft, ChartNoAxesCombined, Download, FolderOpen, Play, Plus, Square, Trash2 } from 'lucide-react'
import { getZagModelSource } from '../lib/models'
import { fullModelRegion } from '../lib/region'
import { assessmentSourceBounds, calculateAssessment } from '../lib/assessmentClient'
import { assessmentComparisonKey, downloadAssessment } from '../lib/assessmentExport'
import { DEFAULT_ASSESSMENT_OPTIONS, type AngleMetrics, type AssessmentOptions, type AssessmentRecord, type AssessmentSession, type HeightMetrics } from '../lib/assessmentTypes'
import type { CaptureSummary, RegionBounds, ViewerModel } from '../types'
import RegionSelection from './RegionSelection'
import { AssessmentHeatmap, AssessmentLineChart } from './AssessmentCharts'
import AdvancedSettings from './AdvancedSettings'
import AssessmentResultDetails from './AssessmentResultDetails'
import { assessmentSignature, createEqualAreaRegion, DEFAULT_EQUAL_AREA_SIZE } from '../lib/assessmentRegion'

interface Props {
  model?: ViewerModel
  captures: CaptureSummary[]
  selectedCaptureId?: string
  busy: boolean
  loadError?: string
  regionEnabled: boolean
  region?: RegionBounds
  onRegionEnabled: (value: boolean) => void
  onRegion: (value: RegionBounds) => void
  onFocusRegion: () => void
  onCapture: (id: string) => void
  getSourceModel: (source: 'current' | 'original') => ViewerModel | undefined
  session: AssessmentSession
  onSession: Dispatch<SetStateAction<AssessmentSession>>
  onBack: () => void
  onOpenFile: () => void
}

function number(value: number | null | undefined, digits = 2): string {
  return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function Numeric({ label, value, onChange, unit = 'mm', min = 0, max = 60, step = .05, disabled = false }: {
  label: string; value: number; onChange: (value: number) => void; unit?: string; min?: number; max?: number; step?: number; disabled?: boolean
}) {
  return <label className="assessment-control"><span>{label}</span><input type="number" aria-label={label} value={value} min={min} max={max} step={step} disabled={disabled}
    onChange={(event) => onChange(event.target.value === '' ? 0 : event.target.valueAsNumber)} /><em>{unit}</em></label>
}

function HeightTable({ surface, raw, central }: { surface: HeightMetrics; raw: HeightMetrics; central: HeightMetrics | null }) {
  const rows: [string, keyof HeightMetrics, string][] = [
    ['RMS / Sq 型均方根偏差', 'rmsUm', 'µm'], ['Sa 型平均绝对偏差', 'meanAbsUm', 'µm'],
    ['PV / Sz 型峰谷值', 'pvUm', 'µm'], ['F98 · P99 − P1', 'f98Um', 'µm'], ['F90 · P95 − P5', 'f90Um', 'µm'],
    ['Sp 型最高峰', 'peakUm', 'µm'], ['Sv 型最深谷', 'pitUm', 'µm'], ['Ssk 型偏斜度', 'skewness', ''], ['Sku 型峰度', 'kurtosis', ''],
  ]
  return <div className="assessment-table-wrap"><table className="assessment-table"><caption>面形貌偏差 · 相对各自基准平面的法向距离</caption>
    <thead><tr><th>指标</th><th>形貌滤波后</th><th>未形貌滤波 · 分析网格</th><th>中央区域 · 滤波后</th></tr></thead>
    <tbody>{rows.map(([label, key, unit]) => <tr key={key}><th>{label}</th><td>{number(surface[key])} {unit}</td><td>{number(raw[key])} {unit}</td><td>{number(central?.[key])} {unit}</td></tr>)}</tbody>
  </table></div>
}

function AngleTable({ rows }: { rows: [string, AngleMetrics | null | undefined][] }) {
  return <div className="assessment-table-wrap"><table className="assessment-table"><caption>坡角绝对值分布 · 不是屏幕开合角</caption><thead><tr><th>方向／范围</th><th>P50</th><th>P95</th><th>P99</th><th>P99.5</th><th>最大值</th><th>P95 坡度</th><th>超阈值面积比</th></tr></thead>
    <tbody>{rows.map(([label, v]) => <tr key={label}><th>{label}</th>{(['p50Deg', 'p95Deg', 'p99Deg', 'p995Deg', 'maxDeg'] as const).map((key) => <td key={key}>{number(v?.[key], 3)}°</td>)}<td>{number(v?.grade95Pct, 3)}%</td><td>{number(v?.aboveThresholdPct)}%</td></tr>)}</tbody>
  </table></div>
}

export default function AssessmentWorkspace(props: Props) {
  const { session, onSession, model, region } = props, o = session.options
  const [computing, setComputing] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState<string>()
  const [mapMode, setMapMode] = useState<'height' | 'cross' | 'normal'>('height')
  const abortRef = useRef<{ controller: AbortController; signature: string } | undefined>(undefined)
  const equalAreaSize = session.equalArea ?? DEFAULT_EQUAL_AREA_SIZE
  const scopeRegion = session.scope === 'selection' && props.regionEnabled && region ? region : model ? fullModelRegion(model) : undefined
  const signature = assessmentSignature(model?.geometry.uuid, scopeRegion, o, session.source)
  const record = session.result, r = record?.result, fresh = record?.signature === signature
  const disabled = computing || props.busy
  const supported = model?.kind === 'zag' && model.hasSourceData
  const recommended = (Object.keys(DEFAULT_ASSESSMENT_OPTIONS) as (keyof AssessmentOptions)[])
    .every((key) => key === 'hingeAxis' || o[key] === DEFAULT_ASSESSMENT_OPTIONS[key])
  useEffect(() => () => { abortRef.current?.controller.abort() }, [])
  useEffect(() => {
    // An auto-crop click updates the selection and starts the matching job atomically.
    // Only unrelated later changes cancel it; never cancel our own newly selected ROI.
    if (abortRef.current && (abortRef.current.signature !== signature || props.busy)) {
      abortRef.current.controller.abort(); abortRef.current = undefined; setComputing(false)
    }
  }, [signature, props.busy])
  const option = <K extends keyof AssessmentOptions>(key: K, value: AssessmentOptions[K]) => onSession((s) => ({ ...s, options: { ...s.options, [key]: value } }))
  const cancel = () => { abortRef.current?.controller.abort(); abortRef.current = undefined; setComputing(false) }

  const runAssessment = async (bounds: RegionBounds, options: AssessmentOptions, scope: string, runSignature: string) => {
    if (disabled || abortRef.current) return
    const sourceModel = props.getSourceModel(session.source)
    const source = sourceModel && getZagModelSource(sourceModel)
    if (!source || !sourceModel?.capture) { setError('请先打开具有完整标定信息的 ZAG；STL 暂不用于计量评估。'); return }
    const controller = new AbortController(); abortRef.current = { controller, signature: runSignature }
    setComputing(true); setProgress(0); setError(undefined)
    try {
      const result = await calculateAssessment({ ...source, capture: sourceModel.capture }, bounds, { ...options }, controller.signal, setProgress)
      if (abortRef.current?.controller !== controller) return
      const next: AssessmentRecord = {
        id: crypto.randomUUID(), signature: runSignature, fileName: sourceModel.fileName, captureName: sourceModel.label,
        captureId: sourceModel.capture.id, sourceKind: sourceModel.spikeRepair ? 'repaired' : 'original',
        repairNote: sourceModel.spikeRepair ? `去尖刺：阈值 ${sourceModel.spikeRepair.options.thresholdUm} µm，半径 ${sourceModel.spikeRepair.stats.effectiveRadiusMm.toFixed(6)} mm，方向 ${sourceModel.spikeRepair.options.direction}` : undefined,
        createdAt: new Date().toISOString(), scope, result,
      }
      onSession((s) => ({ ...s, result: next }))
    } catch (cause) {
      if (abortRef.current?.controller === controller && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : '评估失败')
    } finally {
      if (abortRef.current?.controller === controller) { abortRef.current = undefined; setComputing(false) }
    }
  }

  const analyze = () => {
    const sourceModel = props.getSourceModel(session.source)
    if (!sourceModel || !scopeRegion) return
    const selected = session.scope === 'selection' && props.regionEnabled
    // Full original-data analysis must not inherit repaired-data extrema.
    return runAssessment(assessmentSourceBounds(sourceModel, selected ? scopeRegion : undefined), { ...o },
      selected ? 'XYZ 选区' : '完整采集记录', signature)
  }

  const autoRegionAndAnalyze = () => {
    if (disabled || abortRef.current) return
    const sourceModel = props.getSourceModel(session.source)
    if (!sourceModel?.capture || !getZagModelSource(sourceModel)) { setError('请先打开具有完整标定信息的 ZAG'); return }
    try {
      const bounds = createEqualAreaRegion(sourceModel, equalAreaSize, o.hingeAxis, o.hingeCenterMm)
      const options = { ...o, edgeMarginMm: 0 }
      const nextSignature = assessmentSignature(model?.geometry.uuid, bounds, options, session.source)
      props.onRegion(bounds); props.onRegionEnabled(true)
      onSession((s) => ({ ...s, scope: 'selection', options }))
      // Pass the new bounds explicitly. React state updates are not immediately readable.
      void runAssessment(bounds, options, 'XYZ 选区', nextSignature)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '自动取区失败') }
  }

  const keepResult = () => {
    if (!record || !fresh) return
    onSession((s) => ({ ...s, comparisons: [...s.comparisons.filter((v) => v.id !== record.id), record].slice(-8) }))
  }

  return <>
    <header className="assessment-header">
      <button className="toolbar-button" onClick={props.onBack}><ArrowLeft size={16} />三维查看</button>
      <div className="assessment-heading"><ChartNoAxesCombined size={21} /><div><strong>屏幕评估</strong><span>按真实尺寸计算平整度与折痕</span></div></div>
      <div className="toolbar-spacer" /><button className="toolbar-button" onClick={props.onOpenFile}><FolderOpen size={16} />打开文件</button>
      <button className="toolbar-button" disabled={!record || !fresh || disabled} onClick={() => record && downloadAssessment([record], 'json')}><Download size={16} />结果 JSON</button>
      <button className="toolbar-button" disabled={!record || !fresh || disabled} onClick={() => record && downloadAssessment([record], 'csv')}><Download size={16} />指标 CSV</button>
    </header>
    <div className="assessment-layout">
      <aside className="assessment-settings" aria-label="屏幕评估设置">
        <section className="inspector-section"><h2>数据与评估范围</h2>
          <p className="assessment-source-name">{model?.fileName ?? '尚未打开 ZAG'}</p>
          {!!props.captures.length && <label className="assessment-select"><span>采集记录</span><select aria-label="评估采集记录" value={props.selectedCaptureId} disabled={disabled} onChange={(event) => props.onCapture(event.target.value)}>
            {props.captures.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>}
          <label className="assessment-select"><span>高度数据</span><select aria-label="评估高度数据" value={session.source} disabled={disabled} onChange={(event) => onSession((s) => ({ ...s, source: event.target.value as AssessmentSession['source'] }))}>
            <option value="current">查看器当前数据{model?.spikeRepair ? '（已去尖刺）' : '（原始）'}</option><option value="original">原始 ZAG（忽略去尖刺）</option>
          </select></label>
          <label className="assessment-select"><span>评估范围</span><select aria-label="评估范围" value={session.scope} disabled={disabled} onChange={(event) => onSession((s) => ({ ...s, scope: event.target.value as AssessmentSession['scope'] }))}>
            <option value="selection">当前 XYZ 选区{props.regionEnabled ? '' : '（未开启，使用完整记录）'}</option><option value="full">完整采集记录（忽略选区）</option>
          </select></label>
          <p className="assessment-note">显示放大不影响测量结果。</p>
        </section>
        <section className="inspector-section automatic-assessment"><h2>同面积自动取区</h2>
          <div className="automatic-area-size"><strong>{equalAreaSize.alongMm} × {equalAreaSize.acrossMm}<small> mm</small></strong><span>{number(equalAreaSize.alongMm * equalAreaSize.acrossMm)} mm²</span></div>
          <p className="assessment-note">沿轴 × 跨轴。默认居中，不挑最平处；放不下会提示。</p>
          <button className="obj-download-button" disabled={!supported || disabled} aria-busy={computing} onClick={autoRegionAndAnalyze}>{computing ? '正在评估…' : '自动取同面积区域并评估'}</button>
          <AdvancedSettings label="自动取区高级设置" hint="区域尺寸">
            <Numeric label="沿转轴长度" value={equalAreaSize.alongMm} min={1} max={1000} step={1} disabled={disabled}
              onChange={(v) => onSession((s) => ({ ...s, equalArea: { ...(s.equalArea ?? DEFAULT_EQUAL_AREA_SIZE), alongMm: v } }))} />
            <Numeric label="跨转轴宽度" value={equalAreaSize.acrossMm} min={1} max={1000} step={1} disabled={disabled}
              onChange={(v) => onSession((s) => ({ ...s, equalArea: { ...(s.equalArea ?? DEFAULT_EQUAL_AREA_SIZE), acrossMm: v } }))} />
            <div className="assessment-preset-buttons">
              <button disabled={disabled} onClick={() => onSession((s) => ({ ...s, equalArea: { ...DEFAULT_EQUAL_AREA_SIZE } }))}>80×30 mm（默认）</button>
              <button disabled={disabled} onClick={() => onSession((s) => ({ ...s, equalArea: { alongMm: 80, acrossMm: 12 } }))}>80×12 mm（中央）</button>
            </div>
            <p className="assessment-note">替换当前选区，保留完整高度，内缩边距归零。其他参数和原始文件不变。</p>
            <p className="assessment-note">默认取扫描中心；设置转轴位置后按转轴取区。不同机型仍需手动对齐。跨轴仅 12 mm 时，两侧参考区可能不足，无法计算折痕。</p>
          </AdvancedSettings>
        </section>
        {model?.kind === 'zag' && region && <RegionSelection model={model} enabled={props.regionEnabled} bounds={region} disabled={disabled}
          onEnabled={props.onRegionEnabled} onBounds={props.onRegion} onFocus={() => { props.onFocusRegion(); props.onBack() }} />}
        <section className="inspector-section"><h2>评估方法</h2>
          <label className="assessment-select"><span>转轴沿扫描</span><select aria-label="转轴方向" value={o.hingeAxis} disabled={disabled} onChange={(event) => onSession((s) => ({ ...s, options: { ...s.options, hingeAxis: event.target.value as 'x' | 'y', hingeCenterMm: null } }))}>
            <option value="x">X 方向（跨轴为 Y）</option><option value="y">Y 方向（跨轴为 X）</option>
          </select></label>
          <p className="assessment-note">请确认转轴方向，位置默认在区域中线。</p>
          <div className="settings-default-summary"><strong>{recommended ? '推荐参数 · 可直接评估' : '自定义参数 · 收起后仍生效'}</strong><span>{recommended ? '自动去除摆放倾斜，并轻度滤波。' : '正在使用自定义参数，可恢复推荐值。'}</span></div>
          <AdvancedSettings label="屏幕评估高级设置" hint={recommended ? '推荐参数' : '已自定义'}>
          <h3 className="settings-subheading">分析尺度与参考平面</h3>
          <Numeric label="目标分析间距" value={o.stepMm} min={.02} max={2} onChange={(v) => option('stepMm', v)} disabled={disabled} />
          <label className="assessment-select"><span>形貌滤波 σ</span><select aria-label="形貌滤波尺度" value={o.sigmaMm} disabled={disabled} onChange={(event) => option('sigmaMm', Number(event.target.value))}>
            {[0, .15, .25, .5, 1, 2].map((v) => <option key={v} value={v}>{v === 0 ? '不滤波' : `${v} mm`}</option>)}
          </select></label>
          <Numeric label="整体翘曲 σ" value={o.bowSigmaMm} min={.5} max={20} step={.5} onChange={(v) => option('bowSigmaMm', v)} disabled={disabled} />
          <Numeric label="XY 内缩边距" value={o.edgeMarginMm} min={0} max={20} step={1} onChange={(v) => option('edgeMarginMm', v)} disabled={disabled} />
          <div className="assessment-preset-buttons">{[0, 5, 8].map((v) => <button key={v} disabled={disabled} onClick={() => option('edgeMarginMm', v)}>边距 {v} mm</button>)}</div>
          <label className="assessment-select"><span>参考平面</span><select aria-label="评估参考平面" value={o.plane} disabled={disabled} onChange={(event) => option('plane', event.target.value as AssessmentOptions['plane'])}>
            <option value="least-squares">最小二乘（默认）</option><option value="robust">稳健拟合（Huber）</option>
          </select></label>
          <label className="assessment-checkbox"><input type="checkbox" checked={o.sensitivity} disabled={disabled} onChange={(event) => option('sensitivity', event.target.checked)} />同时检查 σ 0.15 / 0.5 mm 敏感性</label>
          <h3 className="settings-subheading">中央折痕与坡角</h3>
          <label className="assessment-checkbox"><input type="checkbox" aria-label="转轴使用区域中线" checked={o.hingeCenterMm === null} disabled={disabled}
            onChange={(event) => option('hingeCenterMm', event.target.checked ? null : scopeRegion ? (scopeRegion[o.hingeAxis === 'x' ? 'y' : 'x'][0] + scopeRegion[o.hingeAxis === 'x' ? 'y' : 'x'][1]) / 2 : 0)} />转轴使用评估区域中线</label>
          {o.hingeCenterMm !== null && <Numeric label="转轴跨轴坐标" value={o.hingeCenterMm} min={0} max={1000} onChange={(v) => option('hingeCenterMm', v)} disabled={disabled} />}
          <Numeric label="中央半宽" value={o.coreHalfWidthMm} min={.5} max={20} onChange={(v) => option('coreHalfWidthMm', v)} disabled={disabled} />
          <Numeric label="肩部内缘距离" value={o.shoulderInnerMm} min={.5} max={40} onChange={(v) => option('shoulderInnerMm', v)} disabled={disabled} />
          <Numeric label="肩部外缘距离" value={o.shoulderOuterMm} min={1} max={60} onChange={(v) => option('shoulderOuterMm', v)} disabled={disabled} />
          <Numeric label="沿轴分带宽度" value={o.bandWidthMm} min={.5} max={20} onChange={(v) => option('bandWidthMm', v)} disabled={disabled} />
          <Numeric label="坡角超限阈值" value={o.angleThresholdDeg} min={.1} max={30} unit="°" step={.1} onChange={(v) => option('angleThresholdDeg', v)} disabled={disabled} />
          </AdvancedSettings>
          {!recommended && <button className="text-button settings-reset" disabled={disabled}
            title="恢复推荐分析参数，保留转轴方向、数据来源和当前选区"
            onClick={() => onSession((s) => ({ ...s, options: { ...DEFAULT_ASSESSMENT_OPTIONS, hingeAxis: s.options.hingeAxis } }))}>恢复推荐参数</button>}
        </section>
        <div className="assessment-run"><button className="obj-download-button" disabled={!supported || disabled} onClick={() => void analyze()}><Play size={15} />{computing ? `正在计算 ${Math.round(progress * 100)}%` : record ? '重新评估' : '开始评估'}</button>
          {computing && <button className="secondary-button" onClick={cancel}><Square size={12} />取消计算</button>}
          <p>数据仅在本机计算 · 不自动保存 · 不上传</p>
        </div>
      </aside>
      <section className="assessment-results" aria-label="屏幕评估结果" aria-busy={computing || props.busy}>
        <div className="assessment-title-row"><div><h1>{record ? record.captureName : '看看屏幕平不平'}</h1><p>{record ? `${record.fileName} · ${record.scope} · ${record.sourceKind === 'repaired' ? '去尖刺后数据' : '原始数据'} · ${new Date(record.createdAt).toLocaleString()}` : '打开 ZAG，确认转轴方向，即可开始。'}</p></div>
          <button className="secondary-button" disabled={!record || !fresh || disabled} onClick={keepResult}><Plus size={15} />加入本次会话对比</button>
        </div>
        {(error || props.loadError) && <p className="assessment-error" role="alert">{error ?? props.loadError}</p>}
        <button className="obj-download-button assessment-mobile-auto" disabled={!supported || disabled} onClick={autoRegionAndAnalyze}>一键同面积评估 · {equalAreaSize.alongMm}×{equalAreaSize.acrossMm} mm</button>
        {props.busy && <p className="assessment-notice" role="status">正在加载，当前显示的是旧结果。</p>}
        {computing && <div className="assessment-progress" role="status">计算中 {Math.round(progress * 100)}% · 可取消，原始数据不变<div className="progress-track"><i style={{ width: `${progress * 100}%` }} /></div></div>}
        {record && !fresh && <p className="assessment-stale" role="status">数据、选区或参数已变。下方是旧结果，请重新评估后再导出。</p>}
        {!supported && <p className="assessment-notice">请打开 ZAG。STL 缺少可靠标定信息，暂不支持评估。</p>}
        {!r && <div className="assessment-intro"><h2>取同面积区域，比较更方便</h2><p>点击“自动取同面积区域并评估”，即可取区并计算。默认看四项结果，详情按需展开。</p><p>也可评估手动选区或完整屏幕。只提供测量值，不作合格判定。</p></div>}
        {r && record && <>
          <div className="assessment-hero-metrics">
            <div><span>整体平整度 RMS</span><strong>{number(r.surface.rmsUm)}<small>µm</small></strong><p>同一计算条件下，越小越平</p></div>
            <div><span>主要高低差 F98</span><strong>{number(r.surface.f98Um)}<small>µm</small></strong><p>去掉最高、最低各 1% 后的高低差</p></div>
            <div><span>中央折痕起伏</span><strong>{number(r.crease.summary?.amplitudeUm.p50)}<small>µm</small></strong><p>折痕凹下或凸起的典型高度</p></div>
            <div><span>中央坡角 P95</span><strong>{number(r.centralSlopes?.cross.p95Deg, 3)}<small>°</small></strong><p>横跨折痕，95% 的位置不超过此角度</p></div>
          </div>
          <div className="assessment-compact-scope"><span>{record.scope} · {number(r.bounds.x[1] - r.bounds.x[0])} × {number(r.bounds.y[1] - r.bounds.y[0])} mm</span><span>选区面积 {number((r.bounds.x[1] - r.bounds.x[0]) * (r.bounds.y[1] - r.bounds.y[0]))} mm²</span><span>有效覆盖 {number(r.grid.coveragePct)}%</span></div>
          {r.warnings.map((warning) => <p className="assessment-warning" key={warning}>{warning}</p>)}
          {record.repairNote && <p className="assessment-warning">{record.repairNote}。修复点是估算值，请与原始数据对照。</p>}
          <AssessmentResultDetails title="详细指标与图表" hint="平整度 / 坡角 / 折痕">{() => <>
          <section className="assessment-block"><div className="assessment-block-heading"><h2>01 · 面平整度与整体形貌</h2><select aria-label="评估热图类型" value={mapMode} onChange={(event) => setMapMode(event.target.value as typeof mapMode)}><option value="height">高度残差热图</option><option value="cross">跨轴坡角热图</option><option value="normal">法向夹角热图</option></select></div>
            <div className="assessment-surface-grid"><AssessmentHeatmap result={r} mode={mapMode} /><div className="assessment-context"><h3>测量口径</h3><dl><dt>基准平面</dt><dd>{r.options.plane === 'robust' ? 'Huber 稳健拟合' : '最小二乘拟合'}</dd><dt>摆放倾斜角</dt><dd>{number(r.planeTiltDeg, 3)}°（已去除）</dd><dt>整体翘曲 Bow98</dt><dd>{number(r.bow98Um)} µm · 再滤波 σ {r.options.bowSigmaMm} mm</dd><dt>源矩阵有效 / 选入点</dt><dd>{r.sourcePoints.valid.toLocaleString()} / {r.sourcePoints.selected.toLocaleString()}</dd><dt>中央范围</dt><dd>转轴两侧 ±{r.options.coreHalfWidthMm} mm</dd></dl><p>PV 对尖刺最敏感；RMS 描述整体偏差；F98 降低少数极端点的影响；Bow98 只描述更大尺度的起伏。它们不能相互替代。</p></div></div>
            <HeightTable surface={r.surface} raw={r.raw} central={r.central} />
            <p className="assessment-note">上表均基于所示分析网格，“未形貌滤波”不等于全分辨率逐像素统计。极小尖刺可能漏采；需要查看局部极值时，请缩小选区并减小分析间距。选区内源像素的原始 Z 极值（未去倾斜）为 {number(r.sourcePoints.minMm === null ? null : r.sourcePoints.minMm * 1000)} 至 {number(r.sourcePoints.maxMm === null ? null : r.sourcePoints.maxMm * 1000)} µm。</p>
          </section>
          <section className="assessment-block"><h2>02 · 坡度与坡角</h2>
            <p className="assessment-note">超阈值定义：角度 &gt; {r.options.angleThresholdDeg}°。仅在中心及四邻点都有效的网格内统计；跨轴={r.options.hingeAxis === 'x' ? 'Y' : 'X'}，沿轴={r.options.hingeAxis.toUpperCase()}。</p>
            <AngleTable rows={[
              ['全区 · 跨轴', r.slopes?.cross], ['全区 · 沿轴', r.slopes?.along], ['全区 · 法向夹角', r.slopes?.normal],
              ['中央 · 跨轴', r.centralSlopes?.cross], ['中央 · 沿轴', r.centralSlopes?.along], ['中央 · 法向夹角', r.centralSlopes?.normal],
            ]} />
            <div className="assessment-provenance"><span>全区 Sdq 型梯度 RMS {number(r.slopes?.gradientRms, 6)}</span><span>中央梯度 RMS {number(r.centralSlopes?.gradientRms, 6)}</span><span>全区跨轴梯度能量占比 {number(r.slopes?.crossEnergyPct)}%</span><span>有效梯度点 {r.slopes?.cross.count.toLocaleString() ?? '0'}</span></div>
          </section>
          <section className="assessment-block"><h2>03 · 中央折痕与沿轴一致性</h2>
            <p className="assessment-note">每条分带独立使用双侧肩部拟合参考直线；有效分带 {r.crease.validBands} / {r.crease.totalBands}。P5–P95 是位置之间的分布，不是仪器误差或置信区间。</p>
            {r.crease.summary && <div className="assessment-table-wrap"><table className="assessment-table"><caption>折痕分带指标汇总</caption><thead><tr><th>指标</th><th>P5</th><th>P50</th><th>P95</th></tr></thead><tbody>
              {([['凹陷深度 D', 'depthUm', 'µm'], ['隆起高度 B', 'bulgeUm', 'µm'], ['幅值 max(D,B)', 'amplitudeUm', 'µm'], ['中央坡角 P95', 'slope95Deg', '°'], ['主峰半高宽 W50', 'width50Mm', 'mm'], ['绝对截面积 A', 'absAreaUmMm', 'µm·mm']] as const).map(([label, key, unit]) => <tr key={key}><th>{label}</th>{(['p05', 'p50', 'p95'] as const).map((p) => <td key={p}>{number(r.crease.summary?.[key]?.[p])} {unit}</td>)}</tr>)}
            </tbody></table></div>}
            <div className="assessment-chart-grid"><AssessmentLineChart title="跨轴折痕截面" xs={r.crease.profile.acrossMm} unit="µm" xLabel="相对设定转轴位置（mm）" coreHalfWidth={r.options.coreHalfWidthMm}
              curves={[{ label: '分带中位截面', values: r.crease.profile.medianUm, color: '#2874b8' }]} band={{ low: r.crease.profile.p05Um, high: r.crease.profile.p95Um }} />
              <AssessmentLineChart title="折痕沿转轴的变化" xs={r.crease.bands.map((b) => b.alongMm)} unit="µm" xLabel={`${r.options.hingeAxis.toUpperCase()} 扫描坐标（mm）`}
                curves={[{ label: '凹陷深度 D', values: r.crease.bands.map((b) => b.depthUm), color: '#2874b8' }, { label: '隆起高度 B', values: r.crease.bands.map((b) => b.bulgeUm), color: '#b96622' }]} />
            </div>
            <details><summary>查看各分带精确数值</summary><div className="assessment-table-wrap"><table className="assessment-table"><thead><tr><th>沿轴位置 mm</th><th>D µm</th><th>B µm</th><th>坡角 P95 °</th><th>W50 mm</th><th>面积 µm·mm</th><th>覆盖率</th></tr></thead><tbody>
              {r.crease.bands.map((b) => <tr key={b.alongMm}><td>{number(b.alongMm)}</td><td>{number(b.depthUm)}</td><td>{number(b.bulgeUm)}</td><td>{number(b.slope95Deg, 3)}</td><td>{number(b.width50Mm)}</td><td>{number(b.absAreaUmMm)}</td><td>{number(b.coveragePct)}%</td></tr>)}
            </tbody></table></div></details>
          </section>
          {!!r.sensitivity.length && <section className="assessment-block"><h2>滤波尺度敏感性</h2><p className="assessment-note">同一选区、同一网格，仅改变 σ；差异不是测量不确定度。</p><table className="assessment-table"><thead><tr><th>σ mm</th><th>RMS µm</th><th>F98 µm</th><th>中央跨轴 P95 °</th></tr></thead><tbody>
            {[...r.sensitivity, { sigmaMm: r.options.sigmaMm, rmsUm: r.surface.rmsUm, f98Um: r.surface.f98Um, cross95Deg: r.centralSlopes?.cross.p95Deg ?? null }].sort((a, b) => a.sigmaMm - b.sigmaMm).map((v, i) => <tr key={i}><td>{v.sigmaMm}</td><td>{number(v.rmsUm)}</td><td>{number(v.f98Um)}</td><td>{number(v.cross95Deg, 3)}</td></tr>)}
          </tbody></table></section>}
          </>}</AssessmentResultDetails>
        </>}
        {session.comparisons.length > 0 && <section className="assessment-block"><div className="assessment-block-heading"><h2>本次会话对比 · 最多 8 条</h2><button className="secondary-button" disabled={!session.comparisons.length} onClick={() => downloadAssessment(session.comparisons, 'csv')}><Download size={14} />导出对比 CSV</button></div>
          <p className="assessment-note">切换记录后可继续加入；刷新会清空。请自行确认机型、时间和区域对应关系。</p>
          <div className="assessment-table-wrap"><table className="assessment-table"><thead><tr><th>数据／采集记录</th><th>范围 mm</th><th>RMS µm</th><th>F98 µm</th><th>中央跨轴 P95 °</th><th>方法检查</th><th>操作</th></tr></thead><tbody>
            {session.comparisons.map((v) => <tr key={v.id}><th>{v.fileName}<br />{v.captureName} · {v.sourceKind === 'original' ? '原始' : '修复后'}</th><td>{number(v.result.bounds.x[1] - v.result.bounds.x[0], 1)}×{number(v.result.bounds.y[1] - v.result.bounds.y[0], 1)}</td><td>{number(v.result.surface.rmsUm)}</td><td>{number(v.result.surface.f98Um)}</td><td>{number(v.result.centralSlopes?.cross.p95Deg, 3)}</td><td>{assessmentComparisonKey(v) === assessmentComparisonKey(session.comparisons[0]) ? '尺度口径一致；需人工配准' : '范围或口径不同'}</td><td><button className="assessment-delete" aria-label={`删除对比 ${v.captureName}`} onClick={() => onSession((s) => ({ ...s, comparisons: s.comparisons.filter((item) => item.id !== v.id) }))}><Trash2 size={14} /></button></td></tr>)}
          </tbody></table></div>
        </section>}
        <AssessmentResultDetails title="计算说明与范围" hint="采样 / 基准 / 公式">{() => <div className="assessment-methods">
          {r && <div className="assessment-provenance"><span>X {number(r.bounds.x[0], 3)}–{number(r.bounds.x[1], 3)} mm</span><span>Y {number(r.bounds.y[0], 3)}–{number(r.bounds.y[1], 3)} mm</span><span>Z {number(r.bounds.z[0], 4)}–{number(r.bounds.z[1], 4)} mm</span><span>实际间距 {number(r.grid.dxMm, 4)} × {number(r.grid.dyMm, 4)} mm</span><span>有效面积 {number(r.grid.eligibleAreaMm2)} mm²</span><span>{r.grid.nx} × {r.grid.ny} 格 · σ {r.options.sigmaMm} mm</span></div>}
          <p>网格按等面积单元中心双线性采样，分析间距不小于源 XY 间距，最多 60 万格。只分析选区内的表面；不创建缺失高度、不截尾删除高低点。滤波前去倾斜，使用归一化高斯卷积，缺测及覆盖不足 99% 的滤波邻域不参与结果。</p>
          <p>平面为 z=ax+by+c。面高度残差是 (z−ax−by−c)/√(1+a²+b²)。RMS=√mean(r²)，平均绝对偏差=mean(|r|)，PV=max(r)−min(r)，F98=P99−P1。Sa/Sq/Sp/Sv/Ssk/Sku/Sdq 仅借用数学统计形式，不是经过规定滤波链的 ISO 粗糙度认证结果；PV 也不是最小区域法平面度。</p>
          <p>方向坡角为 atan(局部方向梯度)−atan(平面方向梯度)。法向夹角使用局部法向与平面法向的精确三维夹角。坡度%=100×tan(坡角)。梯度 RMS=√mean((∂z/∂x−a)²+(∂z/∂y−b)²)。超阈值比例按有效梯度网格面积计算，不含缺测和边界点。</p>
          <p>折痕先按沿轴分带取中位截面，再进行一维形貌滤波；双肩线参考范围为转轴两侧 [肩部内缘, 肩部外缘]。D/B 在中央半宽内取最低／最高偏差；W50 是中央最大绝对主峰两侧半高交点的间距，交点不存在则留空；A 为两侧肩部内缘之间的绝对截面积。中央未完整覆盖、肩部不完整或覆盖率不足 98% 的分带不报告折痕指标。</p>
          <p>本页是可复现的几何评价工具，不估计仪器误差、视觉可见度、寿命、触感或“合格”分数。默认中线不等于真实转轴，跨机型仍需共同物理区域与对齐。光照反射、屏幕亮度和材料光学性质不能从高度矩阵单独推断。</p>
          <p>方法参考：<a href="https://www.keyence.com/ss/products/microscope/roughness/surface/sdq-root-mean-square-gradient.jsp" target="_blank" rel="noreferrer">基恩士面积参数与 Sdq 定义</a>；<a href="https://www.keyence.com/products/3d-measure/roughness-measure/applications/a-method-for-highly-accurate-and-instantaneous-measurement-of-flatness.jsp" target="_blank" rel="noreferrer">基恩士平面度说明</a>。本页算法及处理边界以本页定义和导出的 JSON 为准，不宣称复刻仪器软件或此前离线报告的全部预处理。</p>
        </div>}</AssessmentResultDetails>
      </section>
    </div>
    <footer className="assessment-footer"><span>{supported ? `${model?.label} · ${model?.spikeRepair && session.source === 'current' ? '修复后高度场' : '原始高度场'}` : '等待 ZAG 数据'}</span><span>{record ? fresh ? '结果与当前范围和参数一致' : '旧结果 · 等待重算' : '等待开始评估'}</span><span>仅几何评估 · 不应用 XYZ 显示倍率</span></footer>
  </>
}
