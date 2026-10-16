import { Eraser } from 'lucide-react'
import { DEFAULT_SPIKE_OPTIONS, type SpikeRemovalOptions, type SpikeRemovalStats } from '../lib/spikeRemoval'
import AdvancedSettings from './AdvancedSettings'

export interface SpikeRemovalPanelProps {
  spikeOptions: SpikeRemovalOptions
  onSpikeOptions: (value: SpikeRemovalOptions) => void
  spikeReport?: { options: SpikeRemovalOptions; stats: SpikeRemovalStats }
  spikeEnabled: boolean
  spikeProcessing: boolean
  spikeProgress: number
  spikeError?: string
  spikeDisabled: boolean
  onRepairSpikes: () => void
  onToggleSpikes: () => void
  onCancelSpikes: () => void
}

export default function SpikeRemovalPanel(props: SpikeRemovalPanelProps) {
  const { spikeOptions: options, spikeReport: report } = props
  const changed = report && (report.options.thresholdUm !== options.thresholdUm
    || report.options.radiusMm !== options.radiusMm || report.options.direction !== options.direction)
  const disabled = props.spikeDisabled || props.spikeProcessing
  const recommended = options.thresholdUm === DEFAULT_SPIKE_OPTIONS.thresholdUm
    && options.radiusMm === DEFAULT_SPIKE_OPTIONS.radiusMm && options.direction === DEFAULT_SPIKE_OPTIONS.direction
  return (
    <section className="inspector-section spike-removal-section">
      <h2><Eraser size={17} />去尖刺 <span className="processing-badge">可逆修复</span></h2>
      <p className="obj-export-note">仅修复孤立突跳，不整体平滑折痕。使用默认参数即可开始。</p>
      <div className="settings-default-summary"><strong>{recommended ? '推荐参数' : '自定义参数'}</strong><span>{options.thresholdUm} µm · {options.radiusMm} mm · {options.direction === 'peaks' ? '仅向上尖刺' : '向上 + 向下突跳'}</span></div>
      <AdvancedSettings label="去尖刺高级设置" hint={recommended ? '推荐参数' : '已自定义'}>
      <label className="field-row numeric-field">
        <span>高度阈值</span>
        <input aria-label="去尖刺高度阈值" type="number" min="1" max="1000" step="1"
          value={options.thresholdUm} disabled={disabled}
          onChange={(event) => props.onSpikeOptions({ ...options, thresholdUm: Number(event.target.value) })} />
        <em>µm</em>
      </label>
      <label className="field-row numeric-field">
        <span>邻域半径</span>
        <input aria-label="去尖刺邻域半径" type="number" min="0.05" max="2" step="0.05"
          value={options.radiusMm} disabled={disabled}
          onChange={(event) => props.onSpikeOptions({ ...options, radiusMm: Number(event.target.value) })} />
        <em>mm</em>
      </label>
      <label className="field-row"><span>修复方向</span>
        <select aria-label="去尖刺修复方向" value={options.direction} disabled={disabled}
          onChange={(event) => props.onSpikeOptions({ ...options, direction: event.target.value as SpikeRemovalOptions['direction'] })}>
          <option value="peaks">仅向上尖刺（默认）</option>
          <option value="both">向上尖刺 + 向下突跳</option>
        </select>
      </label>
      <p className="obj-export-note">阈值越低越敏感；半径决定参考邻域，最长 64 像素。长条折痕、大范围起伏及缺测邻域受保护。作用于整条采集记录，不仅是选区。</p>
      <button className="text-button settings-reset" disabled={disabled || recommended}
        onClick={() => props.onSpikeOptions({ ...DEFAULT_SPIKE_OPTIONS })}>恢复推荐参数</button>
      </AdvancedSettings>
      <div className="spike-actions">
        <button className="obj-download-button" disabled={disabled} onClick={props.onRepairSpikes}>
          {props.spikeProcessing ? `正在修复 ${Math.round(props.spikeProgress * 100)}%` : report ? '重新计算修复' : '计算并应用去尖刺'}
        </button>
        {props.spikeProcessing && <button className="secondary-button" onClick={props.onCancelSpikes}>取消修复</button>}
      </div>
      {report && <>
        <button className="secondary-button spike-compare" disabled={disabled}
          aria-pressed={props.spikeEnabled} onClick={props.onToggleSpikes}>
          {props.spikeEnabled ? '查看原始数据' : '应用修复结果'}
        </button>
        <div className="spike-result" role="status">
          <strong>{props.spikeEnabled ? '当前：修复后' : '当前：原始数据'}</strong>
          <span>修复 {report.stats.changedCount.toLocaleString()} 点 · 向上 {report.stats.positiveCount.toLocaleString()} / 向下 {report.stats.negativeCount.toLocaleString()}</span>
          <span>最大修正 {(report.stats.maxChangeMm * 1000).toFixed(1)} µm · 实际半径 {report.stats.effectiveRadiusMm.toFixed(3)} mm</span>
          <span>已用阈值 {report.options.thresholdUm} µm · 未修改的点保持原值</span>
        </div>
        {changed && <p className="source-warning">参数已修改，点击“重新计算修复”后才会生效。</p>}
      </>}
      {props.spikeError && <p className="obj-export-status is-error" role="alert">{props.spikeError}</p>}
      <p className="spike-caution">修复结果同步用于高度读数、截面、自动范围和 OBJ / 影视导出。原始文件不变。真实小凸点也可能被识别为尖刺，测量结论请对照原始数据。</p>
    </section>
  )
}
