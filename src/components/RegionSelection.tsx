import { Crop, RotateCcw } from 'lucide-react'
import type { RegionBounds, ViewerModel } from '../types'
import { fullModelRegion } from '../lib/region'

interface Props {
  model: ViewerModel
  enabled: boolean
  bounds: RegionBounds
  disabled: boolean
  onEnabled: (value: boolean) => void
  onBounds: (value: RegionBounds) => void
  onFocus: () => void
}

export default function RegionSelection({ model, enabled, bounds, disabled, onEnabled, onBounds, onFocus }: Props) {
  const full = fullModelRegion(model)
  const update = (axis: keyof RegionBounds, side: 0 | 1, value: number) => {
    if (!Number.isFinite(value)) return
    const next: [number, number] = [...bounds[axis]]
    const gap = Math.min(0.000001, (full[axis][1] - full[axis][0]) / 1000)
    next[side] = side === 0
      ? Math.max(full[axis][0], Math.min(value, next[1] - gap))
      : Math.min(full[axis][1], Math.max(value, next[0] + gap))
    onBounds({ ...bounds, [axis]: next })
  }
  return (
    <section className="inspector-section region-section">
      <div className="region-heading">
        <h2><Crop size={17} />区域选择</h2>
        <button
          role="switch"
          aria-label="启用 XYZ 选区"
          aria-checked={enabled}
          disabled={disabled}
          className={`profile-plane-toggle ${enabled ? 'is-on' : ''}`}
          onClick={() => onEnabled(!enabled)}
        >
          <span className="profile-plane-toggle-track"><i /></span>{enabled ? '已启用' : '未启用'}
        </button>
      </div>
      <p className="obj-export-note">按真实毫米坐标裁剪。X/Y 为屏幕平面，Z 为高度；蓝框内的表面会被保留。</p>
      <fieldset hidden={!enabled} disabled={!enabled || disabled} className="region-fields">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <div className="region-axis" key={axis}>
            <div className="region-axis-heading"><strong>{axis.toUpperCase()}</strong><span>{axis === 'z' ? '高度' : axis === 'x' ? '横向' : '纵向'} · mm</span></div>
            <div className="region-values">
              {([0, 1] as const).map((side) => (
                <label key={side}>
                  <span>{side === 0 ? '起点' : '终点'}</span>
                  <input
                    key={bounds[axis][side]}
                    type="number"
                    step="0.001"
                    min={full[axis][0]}
                    max={full[axis][1]}
                    aria-label={`${axis.toUpperCase()} ${side === 0 ? '最小值' : '最大值'}`}
                    defaultValue={Number(bounds[axis][side].toFixed(6))}
                    onBlur={(event) => {
                      if (event.target.value !== '') update(axis, side, event.target.valueAsNumber)
                      event.target.value = String(Number(bounds[axis][side].toFixed(6)))
                    }}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                  />
                </label>
              ))}
            </div>
            <div className="region-sliders">
              {([0, 1] as const).map((side) => (
                <input
                  key={side}
                  aria-label={`${axis.toUpperCase()} ${side === 0 ? '起点滑条' : '终点滑条'}`}
                  type="range" min={full[axis][0]} max={full[axis][1]} step="any"
                  value={bounds[axis][side]}
                  onChange={(event) => update(axis, side, Number(event.target.value))}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="region-actions">
          <button className="secondary-button" onClick={() => onBounds({
            x: [model.widthMm * 0.25, model.widthMm * 0.75],
            y: [model.lengthMm * 0.25, model.lengthMm * 0.75],
            z: full.z,
          })}>中央区域</button>
          <button className="secondary-button" onClick={() => onBounds(full)}><RotateCcw size={12} />恢复全范围</button>
        </div>
        <button className="secondary-button region-focus" onClick={onFocus}>聚焦选区</button>
      </fieldset>
      {enabled && <p className="region-dimensions">选区 {(bounds.x[1] - bounds.x[0]).toFixed(3)} × {(bounds.y[1] - bounds.y[0]).toFixed(3)} × {(bounds.z[1] - bounds.z[0]).toFixed(3)} mm</p>}
    </section>
  )
}
