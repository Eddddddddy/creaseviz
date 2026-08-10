import { useEffect, useRef, type ComponentRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type {
  ExportCameraSettings,
  RotationAxis,
  SurfaceMode,
  ViewerModel,
} from '../types'
import { SceneLighting, SceneSurface } from './SceneSurface'

type OrbitControlsHandle = ComponentRef<typeof OrbitControls>

interface ExportCanvasProps {
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
  cameraSettings: ExportCameraSettings
  rotationAxis: RotationAxis
  rotationAngleDeg: number
  outputWidth: number
  outputHeight: number
  backgroundColor: string
  showGround: boolean
  showGrid: boolean
  cameraLocked: boolean
  onCameraChange: (settings: ExportCameraSettings) => void
  onCanvasReady: (canvas: HTMLCanvasElement) => void
}

function OutputResolution({ width, height, backgroundColor }: {
  width: number
  height: number
  backgroundColor: string
}) {
  const { camera, gl } = useThree()
  useFrame(() => {
    if (gl.domElement.width !== width || gl.domElement.height !== height) {
      gl.setPixelRatio(1)
      gl.setSize(width, height, false)
    }
    if (camera instanceof THREE.PerspectiveCamera && camera.aspect !== width / height) {
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
  })
  useEffect(() => {
    gl.setClearColor(backgroundColor)
  }, [backgroundColor, gl])
  return null
}

function ExportCameraController({ settings, disabled, onChange }: {
  settings: ExportCameraSettings
  disabled: boolean
  onChange: (settings: ExportCameraSettings) => void
}) {
  const controlsRef = useRef<OrbitControlsHandle>(null)
  const suppressChange = useRef(false)
  const { camera } = useThree()

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    const azimuth = THREE.MathUtils.degToRad(settings.azimuthDeg)
    const elevation = THREE.MathUtils.degToRad(settings.elevationDeg)
    const horizontalDistance = Math.cos(elevation) * settings.distanceMm
    suppressChange.current = true
    controls.target.set(settings.targetX, settings.targetY, settings.targetZ)
    camera.position.set(
      settings.targetX + Math.sin(azimuth) * horizontalDistance,
      settings.targetY + Math.sin(elevation) * settings.distanceMm,
      settings.targetZ + Math.cos(azimuth) * horizontalDistance,
    )
    camera.near = Math.max(0.001, settings.distanceMm / 10_000)
    camera.far = Math.max(5000, settings.distanceMm * 100)
    camera.updateProjectionMatrix()
    controls.update()
    suppressChange.current = false
  }, [
    camera,
    settings.azimuthDeg,
    settings.distanceMm,
    settings.elevationDeg,
    settings.targetX,
    settings.targetY,
    settings.targetZ,
  ])

  const emitCameraChange = () => {
    const controls = controlsRef.current
    if (!controls || suppressChange.current) return
    const offset = camera.position.clone().sub(controls.target)
    const distance = Math.max(0.001, offset.length())
    onChange({
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
      enabled={!disabled}
      enableDamping
      dampingFactor={0.08}
      screenSpacePanning
      onChange={emitCameraChange}
    />
  )
}

function RotatingSurface({
  model,
  rotationAxis,
  rotationAngleDeg,
  ...surfaceProps
}: Omit<ExportCanvasProps, 'outputWidth' | 'outputHeight' | 'backgroundColor' | 'showGround' | 'showGrid' | 'cameraLocked' | 'cameraSettings' | 'onCameraChange' | 'onCanvasReady'> & {
  model: ViewerModel
}) {
  const radians = THREE.MathUtils.degToRad(rotationAngleDeg)
  const rotation: [number, number, number] = [
    rotationAxis === 'x' ? radians : 0,
    rotationAxis === 'y' ? radians : 0,
    rotationAxis === 'z' ? radians : 0,
  ]
  return (
    <group rotation={rotation}>
      <SceneSurface model={model} {...surfaceProps} />
    </group>
  )
}

export default function ExportCanvas(props: ExportCanvasProps) {
  const span = props.model ? Math.max(props.model.widthMm, props.model.lengthMm, 1) : 30
  const gridSize = span * 1.6
  const groundY = props.model?.kind === 'zag'
    ? props.model.minHeightMm * props.scaleZ - Math.max(0.05, span * 0.008)
    : -Math.max(0.05, span * 0.008)

  return (
    <Canvas
      shadows="soft"
      dpr={1}
      gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
      camera={{ position: [25, 17, 25], fov: 34, near: 0.001, far: 5000 }}
      onContextMenu={(event) => event.preventDefault()}
      onCreated={({ gl }) => {
        gl.setClearColor(props.backgroundColor)
        gl.shadowMap.enabled = true
        gl.shadowMap.type = THREE.PCFSoftShadowMap
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1
        props.onCanvasReady(gl.domElement)
      }}
    >
      <OutputResolution width={props.outputWidth} height={props.outputHeight} backgroundColor={props.backgroundColor} />
      <SceneLighting model={props.model} strength={props.lightStrength} />
      {props.model && props.showGround && (
        <mesh rotation-x={-Math.PI / 2} position={[0, groundY - 0.003, 0]} receiveShadow>
          <planeGeometry args={[gridSize, gridSize]} />
          <meshStandardMaterial color="#15191f" roughness={0.96} metalness={0} />
        </mesh>
      )}
      {props.model && props.showGrid && (
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
      {props.model && (
        <RotatingSurface
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
          rotationAxis={props.rotationAxis}
          rotationAngleDeg={props.rotationAngleDeg}
        />
      )}
      <ExportCameraController settings={props.cameraSettings} disabled={props.cameraLocked} onChange={props.onCameraChange} />
    </Canvas>
  )
}
