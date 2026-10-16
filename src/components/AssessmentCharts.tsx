import { useEffect, useRef, useState } from 'react'
import type { AssessmentResult } from '../lib/assessmentTypes'

export function AssessmentHeatmap({ result, mode }: { result: AssessmentResult; mode: 'height' | 'cross' | 'normal' }) {
  const ref = useRef<HTMLCanvasElement>(null), frame = useRef<HTMLDivElement>(null)
  const values = mode === 'height' ? result.maps.residualUm : mode === 'cross' ? result.maps.crossDeg : result.maps.normalDeg
  let limit = mode === 'height' ? Math.max(result.surface.peakUm, result.surface.pitUm) : mode === 'cross' ? result.slopes?.cross.p99Deg ?? 1 : result.slopes?.normal.p99Deg ?? 1
  limit = Math.max(1e-6, limit)
  const unit = mode === 'height' ? 'µm' : '°', signed = mode !== 'normal'
  useEffect(() => {
    const canvas = ref.current, container = frame.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const raster = document.createElement('canvas')
    raster.width = result.maps.nx; raster.height = result.maps.ny
    const imageContext = raster.getContext('2d')
    if (!imageContext) return
    const pixels = imageContext.createImageData(raster.width, raster.height)
    for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
      const value = values[y * raster.width + x], target = ((raster.height - 1 - y) * raster.width + x) * 4
      let color: number[]
      if (value === null) color = [91, 100, 111]
      else {
        const t = Math.min(1, Math.abs(value) / limit)
        const end = signed && value < 0 ? [45, 102, 164] : [190, 85, 29]
        color = end.map((v, i) => Math.round([244, 246, 248][i] + (v - [244, 246, 248][i]) * t))
      }
      pixels.data.set([...color, 255], target)
    }
    imageContext.putImageData(pixels, 0, 0)
    const draw = () => {
      const ratio = (result.bounds.x[1] - result.bounds.x[0]) / (result.bounds.y[1] - result.bounds.y[0])
      const width = Math.max(1, Math.min(container.clientWidth, 290 * ratio)), height = width / ratio
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false
      ctx.drawImage(raster, 0, 0, width, height)
      const o = result.options, axis = o.hingeAxis === 'x' ? 'y' : 'x', bounds = result.bounds[axis]
      const center = o.hingeCenterMm ?? (bounds[0] + bounds[1]) / 2
      const t = (center - bounds[0]) / (bounds[1] - bounds[0])
      if (t >= 0 && t <= 1) {
        ctx.strokeStyle = '#151c25'; ctx.lineWidth = 1.25; ctx.setLineDash([5, 4]); ctx.beginPath()
        if (axis === 'y') { ctx.moveTo(0, (1 - t) * height); ctx.lineTo(width, (1 - t) * height) }
        else { ctx.moveTo(t * width, 0); ctx.lineTo(t * width, height) }
        ctx.stroke(); ctx.setLineDash([])
      }
    }
    draw()
    const observer = new ResizeObserver(draw); observer.observe(container)
    return () => observer.disconnect()
  }, [limit, result, signed, values])
  const name = mode === 'height' ? '基准平面高度残差' : mode === 'cross' ? '有符号跨轴坡角' : '局部法向与基准平面的夹角'
  return <figure className="assessment-map">
    <figcaption><strong>{name}</strong><span>虚线：设定转轴 · 灰色：缺测／无有效梯度</span></figcaption>
    <div className="assessment-map-frame" ref={frame}><canvas ref={ref} role="img" aria-label={`${name}热图；单位 ${unit}；有效覆盖率 ${result.grid.coveragePct.toFixed(2)}%；下方提供数值表。`} /></div>
    <div className="assessment-map-axis"><span>X {result.bounds.x[0].toFixed(2)} → {result.bounds.x[1].toFixed(2)} mm</span><span>Y {result.bounds.y[0].toFixed(2)} → {result.bounds.y[1].toFixed(2)} mm（向上）</span></div>
    <div className={`assessment-map-key ${signed ? 'is-signed' : ''}`}><span>{signed ? `−${limit.toFixed(2)}` : '0'} {unit}</span><i /><span>+{limit.toFixed(2)} {unit}</span></div>
    <p className="assessment-note">热图仅为降采样预览，不参与数值统计；坡角色标在 P99 饱和，超出值仍计入统计。坐标未旋转到转轴方向。</p>
  </figure>
}

interface Curve { label: string; values: (number | null)[]; color: string }

export function AssessmentLineChart({ title, xs, curves, unit, xLabel, band, coreHalfWidth }: {
  title: string; xs: number[]; curves: Curve[]; unit: string; xLabel: string
  band?: { low: (number | null)[]; high: (number | null)[] }; coreHalfWidth?: number
}) {
  const container = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(600)
  const hasData = xs.length > 0
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(Math.max(300, Math.round(element.clientWidth))))
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasData])
  const height = 230, left = 60, right = 18, top = 18, bottom = 40
  const samples = [...curves.flatMap((c) => c.values), ...(band?.low ?? []), ...(band?.high ?? [])].filter((v): v is number => v !== null && Number.isFinite(v))
  if (!xs.length || !samples.length) return <figure ref={container} className="assessment-empty-chart">{title}：没有足够有效分带，未绘制估计曲线。</figure>
  const x0 = xs[0], x1 = xs[xs.length - 1], y0 = Math.min(0, ...samples), y1 = Math.max(0, ...samples)
  const yPad = Math.max((y1 - y0) * .08, 0.001), low = y0 - yPad, high = y1 + yPad
  const px = (x: number) => left + (x - x0) / Math.max(1e-9, x1 - x0) * (width - left - right)
  const py = (y: number) => top + (high - y) / (high - low) * (height - top - bottom)
  const path = (values: (number | null)[]) => {
    let open = false
    return values.map((v, i) => {
      if (v === null || !Number.isFinite(v)) { open = false; return '' }
      const command = open ? 'L' : 'M'; open = true
      return `${command}${px(xs[i]).toFixed(2)},${py(v).toFixed(2)}`
    }).join(' ')
  }
  const bandPolygons: string[] = []
  if (band) {
    let run: number[] = []
    const flush = () => {
      if (run.length > 1) bandPolygons.push([...run.map((i) => `${px(xs[i])},${py(band.high[i]!)}`), ...[...run].reverse().map((i) => `${px(xs[i])},${py(band.low[i]!)}`)].join(' '))
      run = []
    }
    for (let i = 0; i < xs.length; i++) {
      if (band.low[i] === null || band.high[i] === null) flush()
      else run.push(i)
    }
    flush()
  }
  // SVG owns labels and vector curves; no heavy chart runtime or extra WebGL context.
  return <figure className="assessment-line-chart" ref={container}>
    <figcaption><strong>{title}</strong><span>{unit}</span></figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}；纵轴 ${unit}；横轴 ${xLabel}。精确分带值见下方表格。`}>
      {coreHalfWidth !== undefined && <rect x={px(Math.max(x0, -coreHalfWidth))} y={top} width={Math.max(0, px(Math.min(x1, coreHalfWidth)) - px(Math.max(x0, -coreHalfWidth)))} height={height - top - bottom} fill="#eef2f6" />}
      {[0, 1, 2, 3, 4].map((i) => {
        const value = low + (high - low) * i / 4
        return <g key={i}><line x1={left} x2={width - right} y1={py(value)} y2={py(value)} stroke="#dce2e8" strokeWidth=".75" /><text x={left - 9} y={py(value) + 4} textAnchor="end">{value.toFixed(Math.abs(high - low) < 2 ? 2 : 1)}</text></g>
      })}
      <line x1={left} x2={width - right} y1={py(0)} y2={py(0)} stroke="#a4adb7" strokeDasharray="4 4" strokeWidth="1" />
      {bandPolygons.map((points, i) => <polygon key={i} points={points} fill="#d2e4f4" opacity=".75" />)}
      {curves.map((c) => <path key={c.label} d={path(c.values)} fill="none" stroke={c.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      {[0, 1, 2, 3, 4].map((i) => <text key={i} x={px(x0 + (x1 - x0) * i / 4)} y={height - 23} textAnchor="middle">{(x0 + (x1 - x0) * i / 4).toFixed(1)}</text>)}
      <text x={(left + width - right) / 2} y={height - 5} textAnchor="middle">{xLabel}</text>
    </svg>
    <div className="assessment-line-key">{curves.map((c) => <span key={c.label}><i style={{ background: c.color }} />{c.label}</span>)}{band && <span><i className="assessment-band-key" />分带 P5–P95 分布，非置信区间</span>}</div>
  </figure>
}
