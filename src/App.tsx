import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Download, Film, FolderOpen, MapPin, RotateCcw, ScanLine, SquareDashedMousePointer, Trash2 } from 'lucide-react'
import CrossSection from './components/CrossSection'
import ExportWorkspace from './components/ExportWorkspace'
import Inspector from './components/Inspector'
import ViewerCanvas from './components/ViewerCanvas'
import { stlFileToModel, zagFieldToModel, zagTextureToRgba } from './lib/models'
import { downloadObj, createViewerModelObj } from './lib/objExportClient'
import type { ObjScaleMode } from './lib/objExport'
import { paletteCss } from './lib/palette'
import { ZagArchive } from './lib/zag'
import type { ExportCameraSettings, InteractionMode, PointMarker, PointerSample, SurfaceMode, ViewPreset, ViewerModel } from './types'

function formatNumber(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface LoadedTexture {
  key: string
  fileName: string
  captureId: string
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export default function App() {
  const [page, setPage] = useState<'viewer' | 'export'>(() => window.location.hash === '#/export' ? 'export' : 'viewer')
  const [archive, setArchive] = useState<ZagArchive>()
  const [model, setModel] = useState<ViewerModel>()
  const [selectedCaptureId, setSelectedCaptureId] = useState<string>()
  const [mode, setMode] = useState<SurfaceMode>('height')
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('camera')
  const [minHeight, setMinHeight] = useState(-0.1)
  const [maxHeight, setMaxHeight] = useState(0.1)
  const [lightStrength, setLightStrength] = useState(0.78)
  const [paletteBrightness, setPaletteBrightness] = useState(0.65)
  const [textureMix, setTextureMix] = useState(0.32)
  const [textureLoading, setTextureLoading] = useState(false)
  const [scaleX, setScaleX] = useState(1)
  const [scaleY, setScaleY] = useState(1)
  const [scaleZ, setScaleZ] = useState(10)
  const [showGrid, setShowGrid] = useState(true)
  const [showProfile, setShowProfile] = useState(true)
  const [showSectionPlane, setShowSectionPlane] = useState(true)
  const [sectionIndex, setSectionIndex] = useState(0)
  const [pointMarkingEnabled, setPointMarkingEnabled] = useState(false)
  const [pointMarkers, setPointMarkers] = useState<PointMarker[]>([])
  const [pointer, setPointer] = useState<PointerSample>()
  const [fps, setFps] = useState(0)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string>()
  const [objScaleMode, setObjScaleMode] = useState<ObjScaleMode>('true')
  const [objExporting, setObjExporting] = useState(false)
  const [objExportProgress, setObjExportProgress] = useState(0)
  const [objExportMessage, setObjExportMessage] = useState<string>()
  const [objExportError, setObjExportError] = useState<string>()
  const [viewRequest, setViewRequest] = useState<{ preset: ViewPreset; nonce: number }>({ preset: 'iso', nonce: 0 })
  const [viewerCamera, setViewerCamera] = useState<ExportCameraSettings>()
  const [modelResetNonce, setModelResetNonce] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const pointMarkerSequence = useRef(0)
  const modelRef = useRef<ViewerModel | undefined>(undefined)
  const loadAbortRef = useRef<AbortController | undefined>(undefined)
  const objExportAbortRef = useRef<AbortController | undefined>(undefined)
  const textureQueueRef = useRef<Promise<void>>(Promise.resolve())
  const textureJobsRef = useRef(new Map<string, Promise<LoadedTexture>>())

  useEffect(() => {
    const syncPage = () => setPage(window.location.hash === '#/export' ? 'export' : 'viewer')
    window.addEventListener('hashchange', syncPage)
    return () => window.removeEventListener('hashchange', syncPage)
  }, [])

  const applyModel = useCallback((next: ViewerModel) => {
    objExportAbortRef.current?.abort()
    objExportAbortRef.current = undefined
    setObjExporting(false)
    setObjExportProgress(0)
    setObjExportMessage(undefined)
    setObjExportError(undefined)
    setModel((previous) => {
      previous?.geometry.dispose()
      return next
    })
    setMinHeight(next.suggestedMinMm)
    setMaxHeight(next.suggestedMaxMm)
    setScaleZ(next.kind === 'zag' ? 10 : 1)
    setMode('height')
    pointMarkerSequence.current = 0
    setPointMarkers([])
    const sectionCount = next.sectionSamples && next.sectionCount ? next.sectionCount : next.crossSections.length
    setSectionIndex(sectionCount > 1 ? Math.round((sectionCount - 1) / 2) : 0)
    setViewRequest((request) => ({ preset: 'iso', nonce: request.nonce + 1 }))
  }, [])

  const addPointMarker = useCallback((sample: PointerSample) => {
    pointMarkerSequence.current += 1
    setPointMarkers((current) => [...current, { id: pointMarkerSequence.current, ...sample }])
  }, [])

  const clearPointMarkers = useCallback(() => {
    pointMarkerSequence.current = 0
    setPointMarkers([])
  }, [])

  const removePointMarker = useCallback((markerId: number) => {
    setPointMarkers((current) => current.filter((marker) => marker.id !== markerId))
  }, [])

  useEffect(() => {
    modelRef.current = model
  }, [model])

  useEffect(() => () => {
    loadAbortRef.current?.abort()
    objExportAbortRef.current?.abort()
    modelRef.current?.geometry.dispose()
  }, [])

  const ensureTexture = useCallback((target: ViewerModel): Promise<LoadedTexture> => {
    const capture = target.capture
    if (!archive || target.kind !== 'zag' || !capture || target.fileName !== archive.fileName) {
      return Promise.reject(new Error('当前模型没有可读取的 ZAG 表面纹理'))
    }

    const key = `${target.fileName}:${capture.id}`
    const existing = textureJobsRef.current.get(key)
    if (existing) return existing

    const source = archive
    const job = textureQueueRef.current.then(async () => {
      const { color, colorStride } = await source.loadTexture(capture)
      const rgba = await zagTextureToRgba(color, capture.width, capture.height, colorStride)
      return {
        key,
        fileName: target.fileName,
        captureId: capture.id,
        width: capture.width,
        height: capture.height,
        rgba,
      }
    })
    textureQueueRef.current = job.then(() => undefined, () => undefined)
    textureJobsRef.current.set(key, job)
    void job.then(
      () => textureJobsRef.current.get(key) === job && textureJobsRef.current.delete(key),
      () => textureJobsRef.current.get(key) === job && textureJobsRef.current.delete(key),
    )
    return job
  }, [archive])

  const attachTexture = useCallback((loaded: LoadedTexture) => {
    setModel((current) => {
      if (
        !current
        || current.fileName !== loaded.fileName
        || current.capture?.id !== loaded.captureId
        || current.textureRgba
      ) return current
      return {
        ...current,
        textureRgba: loaded.rgba,
        textureWidth: loaded.width,
        textureHeight: loaded.height,
      }
    })
  }, [])

  useEffect(() => {
    if (
      textureMix <= 0
      || model?.kind !== 'zag'
      || model.textureRgba
      || !model.capture
      || !archive
      || model.fileName !== archive.fileName
    ) {
      setTextureLoading(false)
      return
    }

    let cancelled = false
    const target = model
    const handle = window.setTimeout(() => {
      if (cancelled) return
      setTextureLoading(true)
      void ensureTexture(target)
        .then((loaded) => {
          if (!cancelled) attachTexture(loaded)
        })
        .catch(() => {
          // Height lighting remains fully usable when a ZAG has no texture.
        })
        .finally(() => {
          if (!cancelled) setTextureLoading(false)
        })
    }, 320)

    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [archive, attachTexture, ensureTexture, model, textureMix])

  const loadCapture = useCallback(async (source: ZagArchive, captureId: string) => {
    const capture = source.captures.find((item) => item.id === captureId)
    if (!capture) return
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    setBusy(true)
    setError(undefined)
    setProgress(0.5)
    try {
      const field = await source.loadCapture(capture, setProgress, controller.signal)
      const next = await zagFieldToModel(field, source.fileName, 220_000, controller.signal)
      setProgress(1)
      applyModel(next)
      setSelectedCaptureId(capture.id)
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'ZAG 采集记录加载失败')
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = undefined
        setBusy(false)
      }
    }
  }, [applyModel])

  const loadFiles = useCallback(async (files: FileList | File[]) => {
    const selected = Array.from(files)
    const zag = selected.find((file) => file.name.toLowerCase().endsWith('.zag'))
    const stl = selected.find((file) => file.name.toLowerCase().endsWith('.stl'))
    if (!zag && !stl) {
      setError('请选择 .zag 或 .stl 文件')
      return
    }
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    setBusy(true)
    setProgress(0.04)
    setError(undefined)
    try {
      if (zag) {
        const nextArchive = await ZagArchive.open(zag, setProgress, controller.signal)
        setArchive(nextArchive)
        const firstCapture = nextArchive.captures[0]
        setSelectedCaptureId(firstCapture.id)
        const field = await nextArchive.loadCapture(firstCapture, setProgress, controller.signal)
        const next = await zagFieldToModel(field, nextArchive.fileName, 220_000, controller.signal)
        setProgress(1)
        applyModel(next)
      } else if (stl) {
        setArchive(undefined)
        setSelectedCaptureId(undefined)
        setProgress(0.25)
        const next = await stlFileToModel(stl, controller.signal)
        setProgress(1)
        applyModel(next)
      }
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : '文件加载失败')
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = undefined
        setBusy(false)
      }
    }
  }, [applyModel])

  const changeMode = useCallback(async (nextMode: SurfaceMode) => {
    if (nextMode !== 'texture' || model?.textureRgba || model?.kind !== 'zag' || !archive || !model.capture) {
      setMode(nextMode)
      return
    }
    setBusy(true)
    setError(undefined)
    setProgress(0.35)
    try {
      const loaded = await ensureTexture(model)
      attachTexture(loaded)
      setProgress(1)
      setMode('texture')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ZAG 纹理加载失败')
    } finally {
      setBusy(false)
    }
  }, [archive, attachTexture, ensureTexture, model])

  const requestView = (preset: ViewPreset) => setViewRequest((request) => ({ preset, nonce: request.nonce + 1 }))

  const resetScene = () => {
    setModelResetNonce((value) => value + 1)
    requestView('reset')
  }

  const takeScreenshot = () => {
    const canvas = document.querySelector<HTMLCanvasElement>('.viewer-stage canvas')
    if (!canvas) return
    const anchor = document.createElement('a')
    anchor.download = `${model?.label ?? 'crease-scan'}-${Date.now()}.png`
    anchor.href = canvas.toDataURL('image/png')
    anchor.click()
  }

  const exportObj = useCallback(async () => {
    if (!model || model.kind !== 'zag' || objExporting) return
    objExportAbortRef.current?.abort()
    const controller = new AbortController()
    objExportAbortRef.current = controller
    setObjExporting(true)
    setObjExportProgress(0)
    setObjExportMessage(undefined)
    setObjExportError(undefined)
    try {
      const result = await createViewerModelObj(model, {
        scaleMode: objScaleMode,
        scaleX,
        scaleY,
        scaleZ,
        signal: controller.signal,
        onProgress: setObjExportProgress,
      })
      downloadObj(result)
      setObjExportProgress(1)
      setObjExportMessage(`已生成并下载 ${result.fileName}（${formatFileSize(result.size)}）`)
    } catch (cause) {
      if (!isAbortError(cause)) setObjExportError(cause instanceof Error ? cause.message : 'OBJ 导出失败')
    } finally {
      if (objExportAbortRef.current === controller) {
        objExportAbortRef.current = undefined
        setObjExporting(false)
      }
    }
  }, [model, objExporting, objScaleMode, scaleX, scaleY, scaleZ])

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    void loadFiles(event.dataTransfer.files)
  }

  const openExportPage = () => {
    window.location.hash = '/export'
  }

  const closeExportPage = () => {
    window.location.hash = ''
  }

  if (page === 'export') {
    return (
      <main className="app-shell export-shell" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <input ref={fileInput} hidden type="file" accept=".zag,.stl" multiple onChange={(event) => event.target.files && void loadFiles(event.target.files)} />
        <ExportWorkspace
          model={model}
          mode={mode}
          minHeight={minHeight}
          maxHeight={maxHeight}
          scaleX={scaleX}
          scaleY={scaleY}
          scaleZ={scaleZ}
          lightStrength={lightStrength}
          paletteBrightness={paletteBrightness}
          textureMix={textureMix}
          viewerCamera={viewerCamera}
          onBack={closeExportPage}
          onOpenFile={() => fileInput.current?.click()}
        />
      </main>
    )
  }

  return (
    <main className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <header className="toolbar">
        <button className="toolbar-button primary" onClick={() => fileInput.current?.click()}><FolderOpen size={18} />打开文件</button>
        <input ref={fileInput} hidden type="file" accept=".zag,.stl" multiple onChange={(event) => event.target.files && void loadFiles(event.target.files)} />
        <div className="toolbar-divider" />
        <button className="toolbar-button" onClick={() => requestView('top')}><Camera size={17} />顶视</button>
        <button className="toolbar-button" onClick={() => requestView('front')}><Camera size={17} />前视</button>
        <button className="toolbar-button" onClick={() => requestView('side')}><Camera size={17} />侧视</button>
        <button className="toolbar-button" onClick={() => requestView('iso')}><SquareDashedMousePointer size={17} />等轴测</button>
        <div className="toolbar-divider" />
        <div className="interaction-mode-toggle" role="group" aria-label="鼠标交互模式">
          <button aria-pressed={interactionMode === 'camera'} className={interactionMode === 'camera' ? 'is-active' : ''} onClick={() => setInteractionMode('camera')}><Camera size={15} />环绕视角</button>
          <button aria-pressed={interactionMode === 'model'} className={interactionMode === 'model' ? 'is-active' : ''} disabled={!model} onClick={() => setInteractionMode('model')}><RotateCcw size={15} />旋转模型</button>
        </div>
        <div className="toolbar-divider" />
        <button
          aria-pressed={pointMarkingEnabled}
          className={`toolbar-button ${pointMarkingEnabled ? 'is-active' : ''}`}
          disabled={!model}
          onClick={() => setPointMarkingEnabled((enabled) => !enabled)}
        >
          <MapPin size={16} />点标记
        </button>
        <button
          aria-label={`清除全部标记，当前 ${pointMarkers.length} 个`}
          className="toolbar-button"
          disabled={pointMarkers.length === 0}
          onClick={clearPointMarkers}
        >
          <Trash2 size={16} />清除
          {pointMarkers.length > 0 && <span className="marker-count">{pointMarkers.length}</span>}
        </button>
        <div className="toolbar-spacer" />
        <button className="toolbar-button" disabled={!model} onClick={takeScreenshot}><Download size={17} />截图</button>
        <button className="toolbar-button" disabled={!model} onClick={openExportPage}><Film size={17} />影视导出</button>
        <button className="toolbar-button" onClick={resetScene}><RotateCcw size={17} />重置</button>
      </header>

      <div className="workspace">
        <section className="viewer-column">
          <div className="viewer-stage">
            <ViewerCanvas
              model={model}
              mode={mode}
              minHeight={minHeight}
              maxHeight={maxHeight}
              scaleX={scaleX}
              scaleY={scaleY}
              scaleZ={scaleZ}
              lightStrength={lightStrength}
              paletteBrightness={paletteBrightness}
              textureMix={textureMix}
              interactionMode={interactionMode}
              modelResetNonce={modelResetNonce}
              showGrid={showGrid}
              showSection={showProfile && showSectionPlane}
              sectionIndex={sectionIndex}
              pointMarkingEnabled={pointMarkingEnabled}
              pointMarkers={pointMarkers}
              viewRequest={viewRequest}
              onPointerSample={setPointer}
              onAddPointMarker={addPointMarker}
              onRemovePointMarker={removePointMarker}
              onFps={setFps}
              onCameraChange={setViewerCamera}
            />
            {!model && !busy && (
              <button className="drop-zone" onClick={() => fileInput.current?.click()}>
                <span className="drop-icon"><ScanLine size={34} /></span>
                <strong>打开折痕扫描</strong>
                <span>拖入 ZAG 原始工程或 STL 表面模型</span>
                <em>所有数据仅在本机处理</em>
              </button>
            )}
            {busy && (
              <div className="loading-overlay">
                <div className="loading-card">
                  <div className="spinner" />
                  <strong>正在解析扫描数据</strong>
                  <span>{Math.round(progress * 100)}%</span>
                  <div className="progress-track"><i style={{ width: `${progress * 100}%` }} /></div>
                </div>
              </div>
            )}
            {error && <button className="error-banner" onClick={() => setError(undefined)}>{error}<span>关闭</span></button>}
            {model && mode === 'height' && (
              <div className="color-legend">
                <strong>高度</strong>
                <div className="legend-scale">
                  <span className="legend-max">{(maxHeight * 1000).toFixed(1)} µm</span>
                  <i style={{ background: paletteCss(model.palette) }} />
                  <span className="legend-min">{(minHeight * 1000).toFixed(1)} µm</span>
                </div>
              </div>
            )}
            {model && <div className="source-chip"><span />{model.kind === 'zag' ? 'ZAG 原始高度场' : 'STL 网格'}</div>}
            {model && pointMarkingEnabled && (
              <div className="interaction-hint is-measuring">
                单击模型添加高度标记 · 可连续添加多个点 · 拖动仍按当前交互方式操作
              </div>
            )}
            {model && interactionMode === 'model' && !pointMarkingEnabled && <div className="interaction-hint">左键拖动旋转 · 右键拖动移动 · 滚轮缩放 · 摄像机 / 灯光固定 · 地面隐藏</div>}
          </div>
          <CrossSection
            model={model}
            sectionIndex={sectionIndex}
            onSectionIndex={setSectionIndex}
            visible={showProfile}
            showSectionPlane={showSectionPlane}
            onShowSectionPlane={setShowSectionPlane}
          />
        </section>

        <Inspector
          model={model}
          captures={archive?.captures ?? []}
          selectedCaptureId={selectedCaptureId}
          onCapture={(id) => archive && void loadCapture(archive, id)}
          mode={mode}
          onMode={(nextMode) => void changeMode(nextMode)}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onMinHeight={setMinHeight}
          onMaxHeight={setMaxHeight}
          lightStrength={lightStrength}
          paletteBrightness={paletteBrightness}
          textureMix={textureMix}
          textureLoading={textureLoading}
          onLightStrength={setLightStrength}
          onPaletteBrightness={setPaletteBrightness}
          onTextureMix={setTextureMix}
          scaleX={scaleX}
          scaleY={scaleY}
          scaleZ={scaleZ}
          onScaleX={setScaleX}
          onScaleY={setScaleY}
          onScaleZ={setScaleZ}
          showGrid={showGrid}
          showProfile={showProfile}
          onShowGrid={setShowGrid}
          onShowProfile={setShowProfile}
          objScaleMode={objScaleMode}
          objExporting={objExporting}
          objExportProgress={objExportProgress}
          objExportMessage={objExportMessage}
          objExportError={objExportError}
          onObjScaleMode={(value) => {
            setObjScaleMode(value)
            setObjExportMessage(undefined)
            setObjExportError(undefined)
          }}
          onExportObj={() => void exportObj()}
        />
      </div>

      <footer className="statusbar">
        <span>坐标 (mm)</span><strong>X {formatNumber(pointer?.xMm ?? Number.NaN)}</strong><strong>Y {formatNumber(pointer?.yMm ?? Number.NaN)}</strong><strong>Z {formatNumber(pointer?.zMm ?? Number.NaN)}</strong>
        <i />
        <span>显示 Z</span><strong>{scaleZ.toFixed(2)}×</strong>
        <i />
        <span>交互</span><strong>{interactionMode === 'model' ? '旋转模型' : '环绕视角'}</strong>
        <i />
        <span>三角形</span><strong>{model ? Math.round(model.triangleCount).toLocaleString() : '—'}</strong>
        <i />
        <span>FPS</span><strong>{fps || '—'}</strong>
      </footer>
    </main>
  )
}
