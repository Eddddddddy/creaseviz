import { useEffect, useMemo, useRef, type ComponentRef, type RefObject } from 'react'
import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport, Grid, Html, OrbitControls } from '@react-three/drei'
import { X } from 'lucide-react'
import * as THREE from 'three'
import type { InteractionMode, PointMarker, PointerSample, SurfaceMode, ViewPreset, ViewerModel } from '../types'
import HeightMaterial from './HeightMaterial'

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

function SceneLighting({ model, strength }: { model?: ViewerModel; strength: number }) {
  const span = model ? Math.max(model.widthMm, model.lengthMm, 1) : 30
  const shadowExtent = span * 0.9
  return (
    <>
      <ambientLight intensity={0.07} />
      <hemisphereLight color="#dce8ff" groundColor="#141920" intensity={0.2} />
      <directionalLight
        castShadow
        color="#fff1d6"
        position={[-span * 0.72, span * 1.35, span * 0.62]}
        intensity={0.55 + strength * 1.9}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={span * 0.05}
        shadow-camera-far={span * 4}
        shadow-camera-left={-shadowExtent}
        shadow-camera-right={shadowExtent}
        shadow-camera-top={shadowExtent}
        shadow-camera-bottom={-shadowExtent}
        shadow-bias={-0.00008}
        shadow-normalBias={0.012}
        shadow-radius={2.5}
      />
    </>
  )
}

function Surface({
  model,
  mode,
  minHeight,
  maxHeight,
  scaleX,
  scaleY,
  scaleZ,
  lightStrength,
  paletteBrightness,
  textureMix,
  showSection,
  sectionIndex,
  pointMarkingEnabled,
  pointMarkers,
  onPointerSample,
  onAddPointMarker,
  onRemovePointMarker,
}: Omit<ViewerCanvasProps, 'showGrid' | 'viewRequest' | 'onFps' | 'interactionMode' | 'modelResetNonce'> & { model: ViewerModel }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const texture = useMemo(() => {
    if (!model.textureRgba || !model.textureWidth || !model.textureHeight) return undefined
    const value = new THREE.DataTexture(
      model.textureRgba,
      model.textureWidth,
      model.textureHeight,
      THREE.RGBAFormat,
    )
    value.colorSpace = THREE.SRGBColorSpace
    value.flipY = true
    value.needsUpdate = true
    return value
  }, [model.textureHeight, model.textureRgba, model.textureWidth])
  useEffect(() => () => texture?.dispose(), [texture])

  const sectionPlane = useMemo(() => {
    if (
      !showSection
      || model.kind !== 'zag'
      || !model.sectionCount
    ) return undefined

    const row = Math.min(Math.max(0, sectionIndex), model.sectionCount - 1)
    const z = (row / Math.max(1, model.sectionCount - 1)) * model.lengthMm
    const heightSpan = Math.max(model.maxHeightMm - model.minHeightMm, 0.01)
    const padding = heightSpan * 0.22
    return {
      z,
      centerY: (model.minHeightMm + model.maxHeightMm) / 2,
      height: heightSpan + padding * 2,
    }
  }, [model, sectionIndex, showSection])

  const meshScale: [number, number, number] =
    model.scaleOrder === 'zag' ? [scaleX, scaleZ, scaleY] : [scaleX, scaleY, scaleZ]
  const meshPosition: [number, number, number] =
    model.kind === 'zag'
      ? [-(model.widthMm * scaleX) / 2, 0, -(model.lengthMm * scaleY) / 2]
      : [-(model.widthMm * scaleX) / 2, 0, (model.lengthMm * scaleY) / 2]

  const onMove = (event: ThreeEvent<PointerEvent>) => {
    if (!meshRef.current) return
    const local = meshRef.current.worldToLocal(event.point.clone())
    const sample = model.kind === 'zag'
      ? { xMm: local.x, yMm: local.z, zMm: local.y }
      : { xMm: local.x, yMm: local.y, zMm: local.z }
    onPointerSample(sample)
  }

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (!pointMarkingEnabled || event.button !== 0 || event.delta > 4 || !meshRef.current) return
    event.stopPropagation()
    const local = meshRef.current.worldToLocal(event.point.clone())
    onAddPointMarker(model.kind === 'zag'
      ? { xMm: local.x, yMm: local.z, zMm: local.y }
      : { xMm: local.x, yMm: local.y, zMm: local.z })
  }

  const markerRadius = Math.max(model.widthMm, model.lengthMm, 1) * 0.0045
  const markerScale: [number, number, number] = model.scaleOrder === 'zag'
    ? [1 / scaleX, 1 / scaleZ, 1 / scaleY]
    : [1 / scaleX, 1 / scaleY, 1 / scaleZ]

  return (
    <mesh
      ref={meshRef}
      geometry={model.geometry}
      castShadow
      receiveShadow
      rotation-x={model.rotationX}
      scale={meshScale}
      position={meshPosition}
      onClick={onClick}
      onPointerMove={onMove}
      onPointerOut={() => onPointerSample(undefined)}
    >
      {mode === 'height' && (
        <HeightMaterial
          geometry={model.geometry}
          palette={model.palette}
          minHeight={minHeight}
          maxHeight={maxHeight}
          heightAxis={model.heightAxis}
          usesHeightAttribute={model.kind === 'zag'}
          surfaceTexture={texture}
          textureMix={model.kind === 'zag' ? textureMix : 0}
          paletteBrightness={paletteBrightness}
        />
      )}
      {mode === 'texture' && texture && <meshStandardMaterial map={texture} side={THREE.DoubleSide} roughness={0.82} />}
      {(mode === 'solid' || (mode === 'texture' && !texture)) && (
        <meshStandardMaterial color="#aab3bd" side={THREE.DoubleSide} roughness={0.72} metalness={0.02} />
      )}
      {sectionPlane && (
        <mesh
          position={[model.widthMm / 2, sectionPlane.centerY, sectionPlane.z]}
          renderOrder={10}
          raycast={() => undefined}
        >
          <planeGeometry args={[model.widthMm * 1.015, sectionPlane.height]} />
          <meshBasicMaterial
            color="#a7c4d8"
            transparent
            opacity={0.13}
            side={THREE.DoubleSide}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
      {pointMarkers.map((marker) => {
        const position: [number, number, number] = model.kind === 'zag'
          ? [marker.xMm, marker.zMm, marker.yMm]
          : [marker.xMm, marker.yMm, marker.zMm]
        const heightMicrons = (marker.zMm * 1000).toFixed(1)
        return (
          <group key={marker.id} position={position} scale={markerScale}>
            <mesh renderOrder={21} raycast={() => undefined}>
              <sphereGeometry args={[markerRadius * 1.42, 18, 18]} />
              <meshBasicMaterial color="#111419" depthTest={false} toneMapped={false} />
            </mesh>
            <mesh renderOrder={22} raycast={() => undefined}>
              <sphereGeometry args={[markerRadius, 18, 18]} />
              <meshBasicMaterial color="#ffd24a" depthTest={false} toneMapped={false} />
            </mesh>
            <Html
              center
              position={[0, markerRadius * 4.6, 0]}
              style={{ pointerEvents: 'auto' }}
              zIndexRange={[80, 40]}
            >
              <button
                aria-label={`删除标记 P${marker.id}，高度 ${heightMicrons} 微米`}
                className="point-marker-label"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemovePointMarker(marker.id)
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title="点击删除此标记"
                type="button"
              >
                <strong>P{marker.id}</strong>
                <span>Z {heightMicrons} µm</span>
                <X aria-hidden="true" className="point-marker-delete-icon" size={11} strokeWidth={2.2} />
              </button>
            </Html>
          </group>
        )
      })}
    </mesh>
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
      <Surface model={model} {...surfaceProps} />
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
      <OrbitControls ref={controlsRef} makeDefault enabled={props.interactionMode === 'camera'} enableDamping dampingFactor={0.08} />
      <CameraRig model={props.model} request={props.viewRequest} controlsRef={controlsRef} />
      <GizmoHelper alignment="bottom-left" margin={[74, 68]}>
        <GizmoViewport axisColors={['#ef5555', '#4dce84', '#4e94ff']} labelColor="white" />
      </GizmoHelper>
      <FpsSampler onFps={props.onFps} />
    </Canvas>
  )
}
