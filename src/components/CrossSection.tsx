import { useMemo } from 'react'
import type { ViewerModel } from '../types'

interface CrossSectionProps {
  model?: ViewerModel
  sectionIndex: number
  onSectionIndex: (value: number) => void
  visible: boolean
  showSectionPlane: boolean
  onShowSectionPlane: (value: boolean) => void
}

export default function CrossSection({
  model,
  sectionIndex,
  onSectionIndex,
  visible,
  showSectionPlane,
  onShowSectionPlane,
}: CrossSectionProps) {
  const sectionCount = model?.sectionSamples && model.sectionCount ? model.sectionCount : (model?.crossSections.length ?? 0)
  const maxSectionIndex = Math.max(0, sectionCount - 1)
  const currentSectionIndex = Math.min(sectionIndex, maxSectionIndex)
  const currentSectionLabel = sectionCount > 1
    ? `${((currentSectionIndex / maxSectionIndex) * 100).toFixed(2)}%`
    : ''

  const chart = useMemo(() => {
    if (!model) return undefined
    const values = model.sectionSamples && model.sectionWidth && model.sectionCount
      ? model.sectionSamples.subarray(
          currentSectionIndex * model.sectionWidth,
          (currentSectionIndex + 1) * model.sectionWidth,
        )
      : model.crossSections[Math.min(currentSectionIndex, model.crossSections.length - 1)]
    if (!values) return undefined
    const finite = Array.from(values).filter(Number.isFinite)
    if (!finite.length) return undefined
    const min = Math.min(...finite)
    const max = Math.max(...finite)
    const width = 1000
    const height = 150
    let drawing = false
    const commands: string[] = []
    Array.from(values).forEach((value, index) => {
      if (!Number.isFinite(value)) {
        drawing = false
        return
      }
      const x = (index / Math.max(1, values.length - 1)) * width
      const y = height - ((value - min) / Math.max(1e-9, max - min)) * (height - 18) - 9
      commands.push(`${drawing ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`)
      drawing = true
    })
    const path = commands.join(' ')
    return { min, max, path }
  }, [currentSectionIndex, model])

  if (!visible) return null
  return (
    <section className="profile-panel">
      <div className="profile-header">
        <div className="profile-header-title">
          <span className="profile-mark" />
          <strong>截面曲线</strong>
          <span className="profile-subtitle">真实 Z，不受显示放大影响</span>
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
                min={0}
                max={maxSectionIndex}
                step={1}
                value={currentSectionIndex}
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
          <div className="profile-empty">载入 ZAG 或 STL 后显示截面</div>
        )}
      </div>
    </section>
  )
}
