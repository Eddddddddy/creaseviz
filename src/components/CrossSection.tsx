import { useMemo } from 'react'
import type { RegionBounds, ViewerModel } from '../types'

interface CrossSectionProps {
  model?: ViewerModel
  sectionIndex: number
  onSectionIndex: (value: number) => void
  visible: boolean
  showSectionPlane: boolean
  onShowSectionPlane: (value: boolean) => void
  region?: RegionBounds
}

export default function CrossSection({
  model,
  sectionIndex,
  onSectionIndex,
  visible,
  showSectionPlane,
  onShowSectionPlane,
  region,
}: CrossSectionProps) {
  const sectionCount = model?.sectionSamples && model.sectionCount ? model.sectionCount : (model?.crossSections.length ?? 0)
  const lastSectionIndex = Math.max(0, sectionCount - 1)
  const minSectionIndex = region && model ? Math.ceil(region.y[0] / model.lengthMm * lastSectionIndex) : 0
  const maxSectionIndex = region && model ? Math.floor(region.y[1] / model.lengthMm * lastSectionIndex) : lastSectionIndex
  const hasSectionInRange = minSectionIndex <= maxSectionIndex
  const currentSectionIndex = Math.max(minSectionIndex, Math.min(sectionIndex, maxSectionIndex))
  const currentSectionLabel = !hasSectionInRange ? '无采样行' : sectionCount > 1
    ? `${((currentSectionIndex / lastSectionIndex) * 100).toFixed(2)}%`
    : ''

  const chart = useMemo(() => {
    if (!model || !hasSectionInRange) return undefined
    const values = model.sectionSamples && model.sectionWidth && model.sectionCount
      ? model.sectionSamples.subarray(
          currentSectionIndex * model.sectionWidth,
          (currentSectionIndex + 1) * model.sectionWidth,
        )
      : model.crossSections[Math.min(currentSectionIndex, model.crossSections.length - 1)]
    if (!values) return undefined
    const selectedValues = Array.from(values, (value, index) => {
      const x = model.crossSectionX[index]
      return !region || (x >= region.x[0] && x <= region.x[1] && value >= region.z[0] && value <= region.z[1])
        ? value : Number.NaN
    })
    const finite = selectedValues.filter(Number.isFinite)
    if (!finite.length) return undefined
    const min = Math.min(...finite)
    const max = Math.max(...finite)
    const width = 1000
    const height = 150
    let drawing = false
    const commands: string[] = []
    selectedValues.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        drawing = false
        return
      }
      const x = region
        ? (model.crossSectionX[index] - region.x[0]) / (region.x[1] - region.x[0]) * width
        : (index / Math.max(1, values.length - 1)) * width
      const y = height - ((value - min) / Math.max(1e-9, max - min)) * (height - 18) - 9
      commands.push(`${drawing ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`)
      drawing = true
    })
    const path = commands.join(' ')
    return { min, max, path }
  }, [currentSectionIndex, hasSectionInRange, model, region])

  if (!visible) return null
  return (
    <section className="profile-panel">
      <div className="profile-header">
        <div className="profile-header-title">
          <span className="profile-mark" />
          <strong>截面曲线</strong>
          <span className="profile-subtitle">{model?.spikeRepair ? '修复后 Z，不受显示放大影响' : region ? '选区内 · 真实 Z' : '真实 Z，不受显示放大影响'}</span>
        </div>
        <div className="profile-header-controls">
          <button
            aria-label="在 3D 模型中显示截面"
            aria-checked={showSectionPlane}
            className={`profile-plane-toggle ${showSectionPlane ? 'is-on' : ''}`}
            onClick={() => onShowSectionPlane(!showSectionPlane)}
            role="switch"
            type="button"
          >
            <span className="profile-plane-toggle-track" aria-hidden="true"><i /></span>
            <span>3D 切面</span>
            <em>{showSectionPlane ? '显示' : '隐藏'}</em>
          </button>
          {sectionCount > 1 && (
            <label className="profile-position-control">
              <span>位置</span>
              <input
                aria-label="截面位置"
                aria-valuetext={currentSectionLabel}
                type="range"
                disabled={!hasSectionInRange}
                min={hasSectionInRange ? minSectionIndex : 0}
                max={hasSectionInRange ? maxSectionIndex : 0}
                step={1}
                value={hasSectionInRange ? currentSectionIndex : 0}
                onInput={(event) => onSectionIndex(Number(event.currentTarget.value))}
              />
              <output>{currentSectionLabel}</output>
            </label>
          )}
        </div>
      </div>
      <div className="profile-chart">
        {chart ? (
          <>
            <svg viewBox="0 0 1000 150" preserveAspectRatio="none" aria-label="截面高度曲线">
              <line x1="0" y1="75" x2="1000" y2="75" className="profile-zero" />
              <path d={chart.path} className="profile-path" />
            </svg>
            <span className="profile-max">{(chart.max * 1000).toFixed(1)} µm</span>
            <span className="profile-min">{(chart.min * 1000).toFixed(1)} µm</span>
          </>
        ) : (
          <div className="profile-empty">{region ? '当前截面没有选区内的有效数据' : '载入 ZAG 或 STL 后显示截面'}</div>
        )}
      </div>
    </section>
  )
}
