import { useEffect, useRef, type ComponentRef, type RefObject } from 'react'
import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { ExportCameraSettings, InteractionMode, PointMarker, PointerSample, SurfaceMode, ViewPreset, ViewerModel } from '../types'
import { SceneLighting, SceneSurface } from './SceneSurface'

type OrbitControlsHandle = ComponentRef<typeof OrbitControls>

interface ViewerCanvasProps {
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
  interactionMode: InteractionMode
  modelResetNonce: number
  showGrid: boolean
  showSection: boolean
  sectionIndex: number
  pointMarkingEnabled: boolean
  pointMarkers: PointMarker[]
  viewRequest: { preset: ViewPreset; nonce: number }
  onPointerSample: (sample?: PointerSample) => void
  onAddPointMarker: (sample: PointerSample) => void
  onRemovePointMarker: (markerId: number) => void
  onFps: (fps: number) => void
  onCameraChange?: (settings: ExportCameraSettings) => void
}

function CameraRig({ model, request, controlsRef }: {
  model?: ViewerModel
  request: { preset: ViewPreset; nonce: number }
  controlsRef: RefObject<OrbitControlsHandle | null>
}) {
  const { camera } = useThree()
  useEffect(() => {
    if (!model || !controlsRef.current) return
    const span = Math.max(model.widthMm, model.lengthMm, 1)
    const positions: Record<ViewPreset, [number, number, number]> = {
      top: [0, span * 1.82, 0.001],
      front: [0, span * 0.2, span * 1.9],
      side: [span * 1.9, span * 0.2, 0],
      iso: [span * 1.05, span * 0.62, span * 1.05],
      reset: [span * 1.05, span * 0.62, span * 1.05],
    }
    camera.position.set(...positions[request.preset])
    camera.near = Math.max(0.001, span / 10_000)
    camera.far = span * 100
    camera.updateProjectionMatrix()
    controlsRef.current.target.set(0, 0, 0)
    controlsRef.current.update()
  }, [camera, controlsRef, model, request])
  return null
}

function FpsSampler({ onFps }: { onFps: (fps: number) => void }) {
  const { gl } = useThree()
  useEffect(() => {
    let frame = 0
    let last = performance.now()
    let handle = 0
    const tick = (now: number) => {
      frame += 1
      if (now - last >= 750) {
        onFps(Math.round((frame * 1000) / (now - last)))
        frame = 0
        last = now
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [gl, onFps])
  return null
}

function ViewerOrbitControls({ enabled, controlsRef, onCameraChange }: {
  enabled: boolean
  controlsRef: RefObject<OrbitControlsHandle | null>
  onCameraChange?: (settings: ExportCameraSettings) => void
}) {
  const { camera } = useThree()
  const emitChange = () => {
    const controls = controlsRef.current
    if (!controls || !onCameraChange) return
    const offset = camera.position.clone().sub(controls.target)
    const distance = Math.max(0.001, offset.length())
    onCameraChange({
      azimuthDeg: THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z)),
      elevationDeg: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(offset.y / distance, -1, 1))),
      distanceMm: distance,
      targetX: controls.target.x,
      targetY: controls.target.y,
      targetZ: controls.target.z,
    })
  }
  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={enabled}
      enableDamping
      dampingFactor={0.08}
      onChange={emitChange}
    />
  )
}

function ModelManipulator({
  model,
  interactionMode,
  modelResetNonce,
  ...surfaceProps
}: ViewerCanvasProps & { model: ViewerModel }) {
  const groupRef = useRef<THREE.Group>(null)
  const dragRef = useRef({ active: false, pointerId: -1, x: 0, y: 0, tool: 'rotate' as 'rotate' | 'move' })
  const cameraRightRef = useRef(new THREE.Vector3())
  const cameraUpRef = useRef(new THREE.Vector3())
  const { camera, gl } = useThree()

  useEffect(() => {
    if (!groupRef.current) return
    groupRef.current.rotation.order = 'YXZ'
    groupRef.current.rotation.set(0, 0, 0)
    groupRef.current.position.set(0, 0, 0)
    groupRef.current.scale.setScalar(1)
  }, [model.geometry, modelResetNonce])

  useEffect(() => {
    gl.domElement.style.cursor = surfaceProps.pointMarkingEnabled ? 'crosshair' : interactionMode === 'model' ? 'grab' : 'default'
    return () => {
      gl.domElement.style.cursor = 'default'
    }
  }, [gl, interactionMode, surfaceProps.pointMarkingEnabled])

  useEffect(() => {
    const canvas = gl.domElement
    const onWheel = (event: WheelEvent) => {
      if (interactionMode !== 'model' || !groupRef.current) return
      event.preventDefault()
      const nextScale = THREE.MathUtils.clamp(
        groupRef.current.scale.x * Math.exp(-event.deltaY * 0.0012),
        0.2,
        5,
      )
      groupRef.current.scale.setScalar(nextScale)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [gl, interactionMode])

  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (interactionMode !== 'model' || (event.button !== 0 && event.button !== 2)) return
    event.stopPropagation()
    const tool = event.button === 2 ? 'move' : 'rotate'
    dragRef.current = { active: true, pointerId: event.pointerId, x: event.clientX, y: event.clientY, tool }
    const target = event.target as unknown as { setPointerCapture?: (pointerId: number) => void }
    target.setPointerCapture?.(event.pointerId)
    gl.domElement.style.cursor = tool === 'move' ? 'move' : 'grabbing'
    surfaceProps.onPointerSample(undefined)
  }

  const onPointerMove = (event: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current
    if (interactionMode !== 'model' || !drag.active || !groupRef.current) return
    event.stopPropagation()
    const deltaX = event.clientX - drag.x
    const deltaY = event.clientY - drag.y
    drag.x = event.clientX
    drag.y = event.clientY
    if (drag.tool === 'move') {
      const perspectiveCamera = camera as THREE.PerspectiveCamera
      const distance = camera.position.distanceTo(groupRef.current.position)
      const worldPerPixel = (
        2 * distance * Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.fov * 0.5))
      ) / Math.max(1, gl.domElement.clientHeight)
      const cameraRight = cameraRightRef.current.setFromMatrixColumn(camera.matrixWorld, 0)
      const cameraUp = cameraUpRef.current.setFromMatrixColumn(camera.matrixWorld, 1)
      groupRef.current.position.addScaledVector(cameraRight, deltaX * worldPerPixel)
      groupRef.current.position.addScaledVector(cameraUp, -deltaY * worldPerPixel)
    } else {
      groupRef.current.rotation.y += deltaX * 0.008
      groupRef.current.rotation.x += deltaY * 0.008
    }
  }

  const finishDrag = (event: ThreeEvent<PointerEvent>) => {
    if (!dragRef.current.active) return
    const target = event.target as unknown as { releasePointerCapture?: (pointerId: number) => void }
    target.releasePointerCapture?.(dragRef.current.pointerId)
    dragRef.current.active = false
    gl.domElement.style.cursor = surfaceProps.pointMarkingEnabled ? 'crosshair' : interactionMode === 'model' ? 'grab' : 'default'
  }

  return (
    <group
      ref={groupRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      <SceneSurface model={model} {...surfaceProps} />
    </group>
  )
}

export default function ViewerCanvas(props: ViewerCanvasProps) {
  const controlsRef = useRef<OrbitControlsHandle>(null)
  const span = props.model ? Math.max(props.model.widthMm, props.model.lengthMm) : 30
  const gridSize = span * 1.45
  const groundY = props.model?.kind === 'zag'
    ? props.model.minHeightMm * props.scaleZ - Math.max(0.05, span * 0.008)
    : -Math.max(0.05, span * 0.008)
  return (
    <Canvas
      shadows="soft"
      gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
      camera={{ position: [25, 17, 25], fov: 34, near: 0.001, far: 5000 }}
      dpr={[1, 1.75]}
      onContextMenu={(event) => event.preventDefault()}
      onCreated={({ gl }) => {
        gl.setClearColor('#111419')
        gl.shadowMap.enabled = true
        gl.shadowMap.type = THREE.PCFSoftShadowMap
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1
      }}
    >
      <SceneLighting model={props.model} strength={props.lightStrength} />
      {props.model && props.interactionMode === 'camera' && (
        <mesh rotation-x={-Math.PI / 2} position={[0, groundY - 0.003, 0]} receiveShadow>
          <planeGeometry args={[gridSize, gridSize]} />
          <meshStandardMaterial color="#15191f" roughness={0.96} metalness={0} />
        </mesh>
      )}
      {props.showGrid && props.interactionMode === 'camera' && (
        <Grid
          args={[gridSize, gridSize]}
          cellSize={1}
          sectionSize={5}
          cellColor="#343a43"
          sectionColor="#4f5966"
          fadeDistance={gridSize * 1.2}
          fadeStrength={1}
          infiniteGrid={false}
          position={[0, groundY, 0]}
        />
      )}
      {props.model && <ModelManipulator {...props} model={props.model} />}
      <ViewerOrbitControls
        controlsRef={controlsRef}
        enabled={props.interactionMode === 'camera'}
        onCameraChange={props.onCameraChange}
      />
      <CameraRig model={props.model} request={props.viewRequest} controlsRef={controlsRef} />
      <GizmoHelper alignment="bottom-left" margin={[74, 68]}>
        <GizmoViewport axisColors={['#ef5555', '#4dce84', '#4e94ff']} labelColor="white" />
      </GizmoHelper>
      <FpsSampler onFps={props.onFps} />
    </Canvas>
  )
}
