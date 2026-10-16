import { Eye, EyeOff, Image as ImageIcon, Layers3, Ratio, ScanLine, SlidersHorizontal } from 'lucide-react'
import type { ObjScaleMode } from '../lib/objExport'
import type { CaptureSummary, ObjDetail, RegionBounds, SurfaceMode, ViewerModel } from '../types'
import RegionSelection from './RegionSelection'
import ObjExportPanel from './ObjExportPanel'
import SpikeRemovalPanel, { type SpikeRemovalPanelProps } from './SpikeRemovalPanel'
import AdvancedSettings from './AdvancedSettings'

interface InspectorProps extends SpikeRemovalPanelProps {
  model?: ViewerModel
  captures: CaptureSummary[]
  selectedCaptureId?: string
  onCapture: (id: string) => void
  mode: SurfaceMode
  onMode: (mode: SurfaceMode) => void
  minHeight: number
  maxHeight: number
  onMinHeight: (value: number) => void
  onMaxHeight: (value: number) => void
  onAutoRange: () => void
  autoRangeComputing: boolean
  autoRangeError?: string
  lightStrength: number
  paletteBrightness: number
  textureMix: number
  textureLoading: boolean
  onLightStrength: (value: number) => void
  onPaletteBrightness: (value: number) => void
  onTextureMix: (value: number) => void
  scaleX: number
  scaleY: number
  scaleZ: number
  onScaleX: (value: number) => void
  onScaleY: (value: number) => void
  onScaleZ: (value: number) => void
  showGrid: boolean
  showProfile: boolean
  onShowGrid: (value: boolean) => void
  onShowProfile: (value: boolean) => void
  objScaleMode: ObjScaleMode
  objExporting: boolean
  objExportProgress: number
  objExportMessage?: string
  objExportError?: string
  onObjScaleMode: (value: ObjScaleMode) => void
  onExportObj: () => void
  regionEnabled: boolean
  region?: RegionBounds
  regionDisabled: boolean
  onRegionEnabled: (value: boolean) => void
  onRegion: (value: RegionBounds) => void
  onFocusRegion: () => void
  objDetail: ObjDetail
  onObjDetail: (value: ObjDetail) => void
}

function AppearanceControl({ label, value, onChange, disabled = false, min = 0, max = 1 }: {
  label: string
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  min?: number
  max?: number
}) {
  return (
    <label className={disabled ? 'appearance-control is-disabled' : 'appearance-control'}>
      <span>{label}</span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step="0.02"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{Math.round(value * 100)}%</output>
    </label>
  )
}

function ScaleControl({ label, value, onChange, max = 20 }: {
  label: string
  value: number
  onChange: (value: number) => void
  max?: number
}) {
  return (
    <div className="scale-control">
      <span>{label}</span>
      <input type="range" min="0.25" max={max} step="0.25" value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{value.toFixed(2)}×</output>
    </div>
  )
}

function LayerToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button className="layer-row" type="button" onClick={() => onChange(!checked)}>
      {checked ? <Eye size={16} /> : <EyeOff size={16} />}
      <span>{label}</span>
      <span className={checked ? 'layer-state is-on' : 'layer-state'}>{checked ? '显示' : '隐藏'}</span>
    </button>
  )
}

export default function Inspector(props: InspectorProps) {
  const capture = props.model?.capture
  const zRange = props.model ? props.model.maxHeightMm - props.model.minHeightMm : 0
  return (
    <aside className="inspector">
      <section className="inspector-section">
        <h2><ScanLine size={17} />数据源</h2>
        {props.model ? (
          <div className="source-summary">
            <div className="source-kind"><span className="status-dot" />{props.model.kind.toUpperCase()} 已加载</div>
            <div className="file-name" title={props.model.fileName}>{props.model.fileName}</div>
          </div>
        ) : (
          <div className="inspector-empty">支持 STL / ZAG</div>
        )}
        {props.captures.length > 0 && (
          <label className="field-row">
            <span>采集记录</span>
            <select value={props.selectedCaptureId} onChange={(event) => props.onCapture(event.target.value)}>
              {props.captures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        )}
        {props.model && (
          <dl className="metadata-grid">
            {capture && <><dt>设备型号</dt><dd>{capture.model}</dd><dt>序列号</dt><dd>{capture.serial}</dd></>}
            <dt>采样尺寸</dt><dd>{capture ? `${capture.width} × ${capture.height}` : '网格模型'}</dd>
            <dt>XY 间距</dt><dd>{capture ? `${(capture.xyPitchMm * 1000).toFixed(4)} µm` : 'STL 未记录'}</dd>
            <dt>{props.model.spikeRepair ? '修复后 Z 范围' : '真实 Z 范围'}</dt><dd>{(zRange * 1000).toFixed(2)} µm</dd>
            <dt>显示网格</dt><dd>{props.model.renderedPointCount.toLocaleString()} 点</dd>
          </dl>
        )}
        {props.model?.warning && <p className="source-warning">{props.model.warning}</p>}
      </section>

      {props.model?.kind === 'zag' && <SpikeRemovalPanel {...props} />}

      {props.model?.kind === 'zag' && props.region && (
        <RegionSelection model={props.model} enabled={props.regionEnabled} bounds={props.region}
          disabled={props.regionDisabled} onEnabled={props.onRegionEnabled} onBounds={props.onRegion}
          onFocus={props.onFocusRegion} />
      )}

      <ObjExportPanel {...props} />

      <section className="inspector-section">
        <h2><SlidersHorizontal size={17} />深度着色</h2>
        <div className="segmented-control">
          <button className={props.mode === 'height' ? 'is-active' : ''} onClick={() => props.onMode('height')}>高度色</button>
          <button disabled={!props.model || (props.model.kind !== 'zag' && !props.model.textureRgba)} className={props.mode === 'texture' ? 'is-active' : ''} onClick={() => props.onMode('texture')}><ImageIcon size={14} />纹理</button>
          <button className={props.mode === 'solid' ? 'is-active' : ''} onClick={() => props.onMode('solid')}>素模</button>
        </div>
        <div className="appearance-controls"><AppearanceControl label="场景灯强度" value={props.lightStrength} onChange={props.onLightStrength} disabled={!props.model} max={2} /></div>
        {props.textureLoading && <p className="texture-status"><span />正在载入 ZAG 表面纹理…</p>}
        <AdvancedSettings label="深度着色高级设置" hint="色标 / 纹理">
        <div className="appearance-controls">
          <AppearanceControl label="高度色亮度" value={props.paletteBrightness} onChange={props.onPaletteBrightness} disabled={!props.model} min={0.25} />
          <AppearanceControl label="纹理融合" value={props.textureMix} onChange={props.onTextureMix} disabled={props.model?.kind !== 'zag'} />
        </div>
        <label className="field-row numeric-field"><span>最小值</span><input type="number" step="0.001" value={Number(props.minHeight.toFixed(6))} onChange={(e) => props.onMinHeight(Number(e.target.value))} /><em>mm</em></label>
        <label className="field-row numeric-field"><span>最大值</span><input type="number" step="0.001" value={Number(props.maxHeight.toFixed(6))} onChange={(e) => props.onMaxHeight(Number(e.target.value))} /><em>mm</em></label>
        </AdvancedSettings>
        <div className="auto-range-row">
          <span>{props.regionEnabled ? '按当前 XYZ 选区计算' : '按完整模型恢复'}</span>
          <button className="text-button" disabled={!props.model || props.regionDisabled || props.autoRangeComputing}
            onClick={props.onAutoRange} aria-busy={props.autoRangeComputing}
            title={props.regionEnabled ? '计算选区内有效表面的真实最小和最大高度' : '恢复完整模型的默认自动范围'}>
            {props.autoRangeComputing ? '计算中…' : '恢复自动范围'}
          </button>
        </div>
        {props.autoRangeError && <p className="auto-range-error" role="status">{props.autoRangeError}</p>}
      </section>

      <section className="inspector-section">
        <h2><Ratio size={17} />显示比例</h2>
        <ScaleControl label="Z" value={props.scaleZ} onChange={props.onScaleZ} max={40} />
        <div className="scale-presets">
          {[1, 5, 10, 20].map((value) => <button key={value} className={props.scaleZ === value ? 'is-active' : ''} onClick={() => props.onScaleZ(value)}>Z×{value}</button>)}
        </div>
        <button className="secondary-button" onClick={() => { props.onScaleX(1); props.onScaleY(1); props.onScaleZ(1) }}>恢复真实比例 1:1:1</button>
        <AdvancedSettings label="显示比例高级设置" hint={`X ${props.scaleX.toFixed(2)}× / Y ${props.scaleY.toFixed(2)}×`}>
          <ScaleControl label="X" value={props.scaleX} onChange={props.onScaleX} />
          <ScaleControl label="Y" value={props.scaleY} onChange={props.onScaleY} />
        </AdvancedSettings>
        {props.scaleZ !== 1 && <p className="scale-notice">当前 Z 为 {props.scaleZ.toFixed(2)}× 夸张显示，测量数值保持真实。</p>}
      </section>

      <section className="inspector-section">
        <h2><Layers3 size={17} />图层</h2>
        <AdvancedSettings label="图层高级设置" hint="网格 / 截面">
          <LayerToggle label="坐标网格" checked={props.showGrid} onChange={props.onShowGrid} />
          <LayerToggle label="截面曲线" checked={props.showProfile} onChange={props.onShowProfile} />
        </AdvancedSettings>
      </section>
    </aside>
  )
}
