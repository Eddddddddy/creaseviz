import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Camera,
  CircleStop,
  Download,
  Film,
  FolderOpen,
  Gauge,
  Monitor,
  Pause,
  Play,
  RefreshCcw,
  Rotate3D,
  Video,
} from 'lucide-react'
import fixWebmDuration from 'fix-webm-duration'
import * as THREE from 'three'
import type {
  ExportCameraSettings,
  ExportQuality,
  RotationAxis,
  RotationDirection,
  SurfaceMode,
  ViewerModel,
} from '../types'
import {
  animationDurationSeconds,
  formatClock,
  safeVideoFileName,
  supportedVideoMimeType,
  validateRecordingSettings,
  VIDEO_LIMITS,
  videoBitrate,
} from '../lib/videoExport'
import ExportCanvas from './ExportCanvas'

interface ExportWorkspaceProps {
  model?: ViewerModel
  mode: SurfaceMode
  minHeight: number
  maxHeight: number
  scaleX: number
  scaleY: number
  scaleZ: number
  lightStrength: number
  paletteBrightness: number
  textureMix: number
  viewerCamera?: ExportCameraSettings
  onBack: () => void
  onOpenFile: () => void
}

type RecorderStatus = 'ready' | 'recording' | 'processing' | 'complete' | 'error' | 'unsupported'

const RESOLUTIONS = [
  { id: '720p', label: '1280 × 720（720p）', width: 1280, height: 720 },
  { id: '1080p', label: '1920 × 1080（1080p）', width: 1920, height: 1080 },
  { id: '1440p', label: '2560 × 1440（1440p）', width: 2560, height: 1440 },
  { id: '4k', label: '3840 × 2160（4K）', width: 3840, height: 2160 },
  { id: 'vertical', label: '1080 × 1920（竖屏）', width: 1080, height: 1920 },
  { id: 'square', label: '1080 × 1080（方形）', width: 1080, height: 1080 },
  { id: 'custom', label: '自定义', width: 1920, height: 1080 },
] as const

function defaultCamera(model?: ViewerModel): ExportCameraSettings {
  const span = model ? Math.max(model.widthMm, model.lengthMm, 1) : 30
  return {
    azimuthDeg: 45,
    elevationDeg: 28,
    distanceMm: span * 1.65,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
  }
}

function clampDimension(value: number): number {
  return Math.round(Math.min(VIDEO_LIMITS.maxDimension, Math.max(64, Number.isFinite(value) ? value : 64)))
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function NumberControl({ label, value, unit, min, max, step = 0.1, disabled, onChange }: {
  label: string
  value: number
  unit?: string
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}) {
  return (
    <label className="export-field-row numeric-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(step < 0.1 ? 3 : 2))}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <em>{unit}</em>
    </label>
  )
}

function ToggleRow({ label, description, checked, disabled, onChange }: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="export-toggle-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}

export default function ExportWorkspace(props: ExportWorkspaceProps) {
  const [cameraSettings, setCameraSettings] = useState<ExportCameraSettings>(() => props.viewerCamera ?? defaultCamera(props.model))
  const [rotationAxis, setRotationAxis] = useState<RotationAxis>('y')
  const [rotationDirection, setRotationDirection] = useState<RotationDirection>('clockwise')
  const [startAngle, setStartAngle] = useState(0)
  const [totalAngle, setTotalAngle] = useState(360)
  const [rotationSpeed, setRotationSpeed] = useState(12)
  const [progressAngle, setProgressAngle] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [resolutionId, setResolutionId] = useState('1080p')
  const [outputWidth, setOutputWidth] = useState(1920)
  const [outputHeight, setOutputHeight] = useState(1080)
  const [outputFps, setOutputFps] = useState(30)
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [backgroundColor, setBackgroundColor] = useState('#111419')
  const [showGround, setShowGround] = useState(true)
  const [showGrid, setShowGrid] = useState(false)
  const [restartOnRecord, setRestartOnRecord] = useState(false)
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>(() => (
    typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream
      ? 'unsupported'
      : 'ready'
  ))
  const [recordingElapsed, setRecordingElapsed] = useState(0)
  const [recordingError, setRecordingError] = useState<string>()
  const [recordingResult, setRecordingResult] = useState<{ url: string; size: number; fileName: string }>()
  const [previewAreaSize, setPreviewAreaSize] = useState({ width: 0, height: 0 })

  const previewAreaRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | undefined>(undefined)
  const recorderRef = useRef<MediaRecorder | undefined>(undefined)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const chunksRef = useRef<Blob[]>([])
  const progressRef = useRef(0)
  const recordingStartedAt = useRef(0)
  const previousModelRef = useRef<ViewerModel | undefined>(undefined)

  const recordingLocked = recorderStatus === 'recording' || recorderStatus === 'processing'
  const durationSeconds = animationDurationSeconds(totalAngle, rotationSpeed)
  const progressRatio = totalAngle > 0 ? Math.min(1, progressAngle / totalAngle) : 0
  const directionSign = rotationDirection === 'clockwise' ? -1 : 1
  const currentRotationAngle = startAngle + progressAngle * directionSign
  const mimeType = useMemo(() => supportedVideoMimeType(
    typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder.isTypeSupported.bind(MediaRecorder),
  ), [])
  const fittedPreviewSize = useMemo(() => {
    const areaRatio = previewAreaSize.width / Math.max(1, previewAreaSize.height)
    const outputRatio = outputWidth / Math.max(1, outputHeight)
    if (areaRatio > outputRatio) {
      return { width: previewAreaSize.height * outputRatio, height: previewAreaSize.height }
    }
    return { width: previewAreaSize.width, height: previewAreaSize.width / outputRatio }
  }, [outputHeight, outputWidth, previewAreaSize])

  useEffect(() => {
    const area = previewAreaRef.current
    if (!area) return
    const updateSize = () => {
      const rect = area.getBoundingClientRect()
      setPreviewAreaSize({ width: rect.width, height: rect.height })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(area)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (props.model && props.model !== previousModelRef.current) {
      previousModelRef.current = props.model
      setCameraSettings(props.viewerCamera ?? defaultCamera(props.model))
      setProgressAngle(0)
      progressRef.current = 0
    }
  }, [props.model, props.viewerCamera])

  useEffect(() => () => {
    if (recordingResult?.url) URL.revokeObjectURL(recordingResult.url)
  }, [recordingResult?.url])

  useEffect(() => () => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.stop()
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    setRecorderStatus('processing')
    try {
      recorder.requestData()
    } catch {
      // Some browsers do not allow requestData during the first encoder tick.
    }
    window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop()
    }, 120)
  }, [])

  useEffect(() => {
    if (!isPlaying || totalAngle <= 0 || rotationSpeed <= 0) return
    let frame = 0
    let lastTime = performance.now()
    const tick = (now: number) => {
      const deltaSeconds = Math.min(0.1, (now - lastTime) / 1000)
      lastTime = now
      const nextProgress = Math.min(totalAngle, progressRef.current + rotationSpeed * deltaSeconds)
      progressRef.current = nextProgress
      setProgressAngle(nextProgress)
      if (nextProgress >= totalAngle) {
        setIsPlaying(false)
        if (recorderRef.current?.state === 'recording') stopRecording()
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [isPlaying, rotationSpeed, stopRecording, totalAngle])

  useEffect(() => {
    if (recorderStatus !== 'recording') return
    const timer = window.setInterval(() => {
      setRecordingElapsed((performance.now() - recordingStartedAt.current) / 1000)
    }, 100)
    return () => window.clearInterval(timer)
  }, [recorderStatus])

  const resetPlayback = useCallback(() => {
    if (recordingLocked) return
    setIsPlaying(false)
    progressRef.current = 0
    setProgressAngle(0)
  }, [recordingLocked])

  const togglePlayback = () => {
    if (!props.model || recordingLocked) return
    if (isPlaying) {
      setIsPlaying(false)
      return
    }
    if (progressRef.current >= totalAngle) {
      progressRef.current = 0
      setProgressAngle(0)
    }
    setIsPlaying(true)
  }

  const updateProgress = (value: number) => {
    if (recordingLocked) return
    setIsPlaying(false)
    progressRef.current = value
    setProgressAngle(value)
  }

  const clearRecordingResult = () => {
    setRecordingResult((current) => {
      if (current) URL.revokeObjectURL(current.url)
      return undefined
    })
  }

  const startRecording = async () => {
    if (!props.model || !canvasRef.current || !mimeType || recordingLocked) return
    setRecordingError(undefined)
    const shouldRestart = restartOnRecord || progressRef.current >= totalAngle
    const remainingAngle = shouldRestart ? totalAngle : Math.max(0, totalAngle - progressRef.current)
    const settingsError = validateRecordingSettings(
      outputWidth,
      outputHeight,
      outputFps,
      animationDurationSeconds(remainingAngle, rotationSpeed),
    )
    if (settingsError) {
      setRecordingError(settingsError)
      setRecorderStatus('error')
      return
    }
    clearRecordingResult()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const stream = canvas.captureStream(outputFps)
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: videoBitrate(outputWidth, outputHeight, outputFps, quality),
      })
      chunksRef.current = []
      streamRef.current = stream
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = undefined
        setRecordingError('浏览器录制器发生错误，请降低分辨率或帧率后重试。')
        setRecorderStatus('error')
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = undefined
        recorderRef.current = undefined
        const rawBlob = new Blob(chunksRef.current, { type: mimeType })
        if (rawBlob.size === 0) {
          setRecordingError('没有生成有效的视频数据，请重新录制。')
          setRecorderStatus('error')
          return
        }
        try {
          const durationMs = Math.max(1, performance.now() - recordingStartedAt.current)
          const blob = await fixWebmDuration(rawBlob, durationMs, { logger: false })
          const fileName = safeVideoFileName(props.model?.label ?? 'crease-scan', outputWidth, outputHeight, outputFps)
          setRecordingResult({ url: URL.createObjectURL(blob), size: blob.size, fileName })
          setRecorderStatus('complete')
        } catch (cause) {
          setRecordingError(cause instanceof Error ? cause.message : '无法写入视频时长信息')
          setRecorderStatus('error')
        }
      }
      if (shouldRestart) {
        progressRef.current = 0
        setProgressAngle(0)
      }
      recorder.start(500)
      recordingStartedAt.current = performance.now()
      setRecordingElapsed(0)
      setRecorderStatus('recording')
      if (!isPlaying || shouldRestart) requestAnimationFrame(() => setIsPlaying(true))
    } catch (cause) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      setRecordingError(cause instanceof Error ? cause.message : '无法启动视频录制')
      setRecorderStatus('error')
    }
  }

  const downloadRecording = () => {
    if (!recordingResult) return
    const anchor = document.createElement('a')
    anchor.href = recordingResult.url
    anchor.download = recordingResult.fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const applyResolution = (id: string) => {
    setResolutionId(id)
    const preset = RESOLUTIONS.find((item) => item.id === id)
    if (!preset || id === 'custom') return
    setOutputWidth(preset.width)
    setOutputHeight(preset.height)
  }

  const applyCameraPreset = (preset: 'top' | 'front' | 'side' | 'iso') => {
    const base = defaultCamera(props.model)
    const presets: Record<typeof preset, Pick<ExportCameraSettings, 'azimuthDeg' | 'elevationDeg'>> = {
      top: { azimuthDeg: 0, elevationDeg: 89 },
      front: { azimuthDeg: 0, elevationDeg: 12 },
      side: { azimuthDeg: 90, elevationDeg: 12 },
      iso: { azimuthDeg: 45, elevationDeg: 28 },
    }
    setCameraSettings({ ...base, ...presets[preset] })
  }

  const updateCamera = (patch: Partial<ExportCameraSettings>) => {
    setCameraSettings((current) => ({ ...current, ...patch }))
  }

  const cameraPosition = useMemo(() => {
    const azimuth = THREE.MathUtils.degToRad(cameraSettings.azimuthDeg)
    const elevation = THREE.MathUtils.degToRad(cameraSettings.elevationDeg)
    const horizontalDistance = Math.cos(elevation) * cameraSettings.distanceMm
    return {
      x: cameraSettings.targetX + Math.sin(azimuth) * horizontalDistance,
      y: cameraSettings.targetY + Math.sin(elevation) * cameraSettings.distanceMm,
      z: cameraSettings.targetZ + Math.cos(azimuth) * horizontalDistance,
    }
  }, [cameraSettings])

  const statusLabel: Record<RecorderStatus, string> = {
    ready: '就绪',
    recording: '正在录制',
    processing: '正在生成视频',
    complete: '录制完成',
    error: '录制失败',
    unsupported: '浏览器不支持',
  }

  return (
    <>
      <header className="toolbar export-toolbar">
        <button className="toolbar-button" onClick={props.onBack}><ArrowLeft size={17} />返回查看器</button>
        <div className="toolbar-divider" />
        <div className="export-title"><Film size={19} /><strong>影视导出</strong></div>
        {props.model && <div className="export-file-chip"><span />{props.model.fileName}</div>}
        <div className="toolbar-spacer" />
        <button className="toolbar-button" onClick={props.onOpenFile}><FolderOpen size={17} />打开文件</button>
      </header>

      <div className="export-workspace">
        <section className="export-preview-column">
          <div ref={previewAreaRef} className="export-preview-area">
          <div
            className="export-preview-frame"
            style={{
              width: fittedPreviewSize.width || undefined,
              height: fittedPreviewSize.height || undefined,
              aspectRatio: `${outputWidth} / ${outputHeight}`,
            }}
          >
            <ExportCanvas
              model={props.model}
              mode={props.mode}
              minHeight={props.minHeight}
              maxHeight={props.maxHeight}
              scaleX={props.scaleX}
              scaleY={props.scaleY}
              scaleZ={props.scaleZ}
              lightStrength={props.lightStrength}
              paletteBrightness={props.paletteBrightness}
              textureMix={props.textureMix}
              cameraSettings={cameraSettings}
              rotationAxis={rotationAxis}
              rotationAngleDeg={currentRotationAngle}
              outputWidth={outputWidth}
              outputHeight={outputHeight}
              backgroundColor={backgroundColor}
              showGround={showGround}
              showGrid={showGrid}
              cameraLocked={recordingLocked}
              onCameraChange={setCameraSettings}
              onCanvasReady={(canvas) => { canvasRef.current = canvas }}
            />
            {!props.model && (
              <button className="export-empty" onClick={props.onOpenFile}>
                <Film size={36} />
                <strong>请先打开折痕扫描</strong>
                <span>导出页面会沿用查看器中的模型、材质和灯光</span>
              </button>
            )}
            <div className="export-preview-meta">
              <span>{outputWidth} × {outputHeight}</span>
              <span>{outputFps} FPS</span>
              <span>WebM</span>
            </div>
            {recorderStatus === 'recording' && <div className="recording-badge"><i />REC {formatClock(recordingElapsed, true)}</div>}
          </div>
          </div>

          <div className="transport-bar">
            <button aria-label="复位播放" disabled={recordingLocked} onClick={resetPlayback}><RefreshCcw size={18} /></button>
            <button className="transport-primary" aria-label={isPlaying ? '暂停' : '播放'} disabled={!props.model || recordingLocked} onClick={togglePlayback}>
              {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>
            <div className="transport-time"><strong>{currentRotationAngle.toFixed(1)}°</strong><span>{formatClock(progressAngle / Math.max(rotationSpeed, 0.001), true)}</span></div>
            <input
              aria-label="动画进度"
              type="range"
              min="0"
              max={Math.max(0.01, totalAngle)}
              step="0.01"
              value={progressAngle}
              disabled={recordingLocked}
              onChange={(event) => updateProgress(Number(event.target.value))}
            />
            <div className="transport-duration"><span>总角度</span><strong>{totalAngle.toFixed(1)}°</strong></div>
            <div className="transport-duration"><span>时长</span><strong>{formatClock(durationSeconds, true)}</strong></div>
          </div>
        </section>

        <aside className="export-inspector">
          <fieldset disabled={recordingLocked}>
            <section className="export-inspector-section">
              <h2><Camera size={17} />相机</h2>
              <div className="camera-presets">
                <button onClick={() => applyCameraPreset('top')}>顶视</button>
                <button onClick={() => applyCameraPreset('front')}>前视</button>
                <button onClick={() => applyCameraPreset('side')}>侧视</button>
                <button onClick={() => applyCameraPreset('iso')}>斜视</button>
              </div>
              <NumberControl label="方位角" value={cameraSettings.azimuthDeg} unit="°" step={0.1} onChange={(value) => updateCamera({ azimuthDeg: value })} />
              <NumberControl label="俯仰角" value={cameraSettings.elevationDeg} unit="°" min={-89} max={89} step={0.1} onChange={(value) => updateCamera({ elevationDeg: value })} />
              <NumberControl label="距离" value={cameraSettings.distanceMm} unit="mm" min={0.01} step={0.1} onChange={(value) => updateCamera({ distanceMm: Math.max(0.01, value) })} />
              <div className="export-subheading">观察中心</div>
              <NumberControl label="X" value={cameraSettings.targetX} unit="mm" step={0.1} onChange={(value) => updateCamera({ targetX: value })} />
              <NumberControl label="Y" value={cameraSettings.targetY} unit="mm" step={0.1} onChange={(value) => updateCamera({ targetY: value })} />
              <NumberControl label="Z" value={cameraSettings.targetZ} unit="mm" step={0.1} onChange={(value) => updateCamera({ targetZ: value })} />
              <div className="camera-position-readout">相机位置 X {cameraPosition.x.toFixed(1)} / Y {cameraPosition.y.toFixed(1)} / Z {cameraPosition.z.toFixed(1)} mm</div>
              <div className="export-button-row">
                <button disabled={!props.viewerCamera} onClick={() => props.viewerCamera && setCameraSettings(props.viewerCamera)}>使用查看器视角</button>
                <button onClick={() => setCameraSettings(defaultCamera(props.model))}>重置</button>
              </div>
            </section>

            <section className="export-inspector-section">
              <h2><Rotate3D size={17} />旋转</h2>
              <div className="export-field-row">
                <span>旋转轴</span>
                <div className="axis-segmented">
                  {(['x', 'y', 'z'] as RotationAxis[]).map((axis) => (
                    <button key={axis} className={rotationAxis === axis ? 'is-active' : ''} onClick={() => { setRotationAxis(axis); resetPlayback() }}>{axis.toUpperCase()}</button>
                  ))}
                </div>
              </div>
              <label className="export-field-row">
                <span>方向</span>
                <select value={rotationDirection} onChange={(event) => { setRotationDirection(event.target.value as RotationDirection); resetPlayback() }}>
                  <option value="clockwise">顺时针</option>
                  <option value="counterclockwise">逆时针</option>
                </select>
              </label>
              <NumberControl label="起始角" value={startAngle} unit="°" step={0.1} onChange={(value) => { setStartAngle(value); resetPlayback() }} />
              <NumberControl label="总角度" value={totalAngle} unit="°" min={0.1} max={3600} step={1} onChange={(value) => { setTotalAngle(Math.min(3600, Math.max(0.1, value))); resetPlayback() }} />
              <NumberControl label="速度" value={rotationSpeed} unit="°/s" min={0.1} max={360} step={0.1} onChange={(value) => setRotationSpeed(Math.min(360, Math.max(0.1, value)))} />
              <div className="derived-value"><Gauge size={14} /><span>计算时长</span><strong>{formatClock(durationSeconds, true)}</strong></div>
            </section>

            <section className="export-inspector-section">
              <h2><Monitor size={17} />输出</h2>
              <label className="export-field-row">
                <span>分辨率</span>
                <select value={resolutionId} onChange={(event) => applyResolution(event.target.value)}>
                  {RESOLUTIONS.map((resolution) => <option key={resolution.id} value={resolution.id}>{resolution.label}</option>)}
                </select>
              </label>
              <div className="custom-resolution">
                <input aria-label="视频宽度" type="number" min="64" max="7680" value={outputWidth} onChange={(event) => { setResolutionId('custom'); setOutputWidth(Math.min(clampDimension(Number(event.target.value)), Math.floor(VIDEO_LIMITS.maxPixels / outputHeight))) }} />
                <span>×</span>
                <input aria-label="视频高度" type="number" min="64" max="7680" value={outputHeight} onChange={(event) => { setResolutionId('custom'); setOutputHeight(Math.min(clampDimension(Number(event.target.value)), Math.floor(VIDEO_LIMITS.maxPixels / outputWidth))) }} />
                <em>px</em>
              </div>
              <label className="export-field-row"><span>帧率</span><select value={outputFps} onChange={(event) => setOutputFps(Number(event.target.value))}>{[24, 25, 30, 50, 60].map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}</select></label>
              <label className="export-field-row"><span>画质</span><select value={quality} onChange={(event) => setQuality(event.target.value as ExportQuality)}><option value="standard">标准</option><option value="high">高（推荐）</option><option value="maximum">最高</option></select></label>
              <label className="export-field-row color-field"><span>背景</span><input type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} /><output>{backgroundColor.toUpperCase()}</output></label>
              <ToggleRow label="地面" checked={showGround} onChange={setShowGround} />
              <ToggleRow label="坐标网格" description="会录入视频" checked={showGrid} onChange={setShowGrid} />
              {(outputWidth >= 3840 || outputHeight >= 2160 || outputFps >= 60) && <p className="export-performance-note">高分辨率或高帧率会显著增加 GPU 负载；实时录制时实际帧率取决于本机性能。</p>}
            </section>
          </fieldset>

          <section className="export-inspector-section recording-section">
            <h2><Video size={17} />录制</h2>
            <div className="recording-status-row"><span className={`record-status-dot is-${recorderStatus}`} /><span>录制状态</span><strong>{statusLabel[recorderStatus]}</strong></div>
            <div className="recording-progress"><i style={{ width: `${progressRatio * 100}%` }} /></div>
            <dl className="recording-metadata"><dt>格式</dt><dd>{mimeType?.includes('vp9') ? 'WebM · VP9' : mimeType?.includes('vp8') ? 'WebM · VP8' : 'WebM'}</dd><dt>已用时</dt><dd>{formatClock(recordingElapsed, true)}</dd></dl>
            <ToggleRow label="从起始角重新录制" description="关闭时从当前播放位置继续" checked={restartOnRecord} disabled={recordingLocked} onChange={setRestartOnRecord} />
            {recorderStatus === 'unsupported' && <p className="recording-error">当前浏览器不支持画布视频录制，请使用最新版 Chromium 浏览器。</p>}
            {recordingError && <p className="recording-error">{recordingError}</p>}
            {recordingResult && (
              <div className="recording-result">
                <strong>{recordingResult.fileName}</strong>
                <span>{formatFileSize(recordingResult.size)}</span>
              </div>
            )}
            <button className="export-action-button play-button" disabled={!props.model || recordingLocked} onClick={togglePlayback}>{isPlaying ? <><Pause size={18} />暂停播放</> : <><Play size={18} />开始播放</>}</button>
            {recorderStatus === 'recording' || recorderStatus === 'processing' ? (
              <button className="export-action-button stop-button" disabled={recorderStatus === 'processing'} onClick={stopRecording}><CircleStop size={18} />{recorderStatus === 'processing' ? '正在生成…' : '停止录制'}</button>
            ) : (
              <button className="export-action-button record-button" disabled={!props.model || recorderStatus === 'unsupported' || !mimeType} onClick={() => void startRecording()}><span className="record-icon" />开始录制</button>
            )}
            <button className="export-action-button download-button" disabled={!recordingResult} onClick={downloadRecording}><Download size={18} />下载视频</button>
          </section>
        </aside>
      </div>

      <footer className="statusbar export-statusbar">
        <span>输出</span><strong>{outputWidth} × {outputHeight}</strong><i />
        <span>帧率</span><strong>{outputFps} FPS</strong><i />
        <span>相机</span><strong>{cameraSettings.azimuthDeg.toFixed(1)}° / {cameraSettings.elevationDeg.toFixed(1)}° / {cameraSettings.distanceMm.toFixed(1)} mm</strong><i />
        <span>旋转</span><strong>{rotationAxis.toUpperCase()} · {currentRotationAngle.toFixed(1)}°</strong>
      </footer>
    </>
  )
}
