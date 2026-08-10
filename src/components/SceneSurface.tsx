import { useEffect, useMemo, useRef } from 'react'
import { Html } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import { X } from 'lucide-react'
import * as THREE from 'three'
import type { PointMarker, PointerSample, SurfaceMode, ViewerModel } from '../types'
import HeightMaterial from './HeightMaterial'

export interface SceneSurfaceProps {
  model: ViewerModel
  mode: SurfaceMode
  minHeight: number
  maxHeight: number
  scaleX: number
  scaleY: number
  scaleZ: number
  paletteBrightness: number
  textureMix: number
  showSection?: boolean
  sectionIndex?: number
  pointMarkingEnabled?: boolean
  pointMarkers?: PointMarker[]
  onPointerSample?: (sample?: PointerSample) => void
  onAddPointMarker?: (sample: PointerSample) => void
  onRemovePointMarker?: (markerId: number) => void
}

export function SceneLighting({ model, strength }: { model?: ViewerModel; strength: number }) {
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

export function SceneSurface({
  model,
  mode,
  minHeight,
  maxHeight,
  scaleX,
  scaleY,
  scaleZ,
  paletteBrightness,
  textureMix,
  showSection = false,
  sectionIndex = 0,
  pointMarkingEnabled = false,
  pointMarkers = [],
  onPointerSample,
  onAddPointMarker,
  onRemovePointMarker,
}: SceneSurfaceProps) {
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
    if (!showSection || model.kind !== 'zag' || !model.sectionCount) return undefined

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

  const sampleAtEvent = (event: ThreeEvent<PointerEvent | MouseEvent>): PointerSample | undefined => {
    if (!meshRef.current) return undefined
    const local = meshRef.current.worldToLocal(event.point.clone())
    return model.kind === 'zag'
      ? { xMm: local.x, yMm: local.z, zMm: local.y }
      : { xMm: local.x, yMm: local.y, zMm: local.z }
  }

  const onMove = (event: ThreeEvent<PointerEvent>) => {
    onPointerSample?.(sampleAtEvent(event))
  }

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (!pointMarkingEnabled || event.button !== 0 || event.delta > 4) return
    const sample = sampleAtEvent(event)
    if (!sample) return
    event.stopPropagation()
    onAddPointMarker?.(sample)
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
      onPointerOut={() => onPointerSample?.(undefined)}
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
                  onRemovePointMarker?.(marker.id)
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
