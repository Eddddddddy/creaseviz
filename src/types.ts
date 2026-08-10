import type * as THREE from 'three'

export type ViewPreset = 'top' | 'front' | 'side' | 'iso' | 'reset'
export type SurfaceMode = 'height' | 'texture' | 'solid'
export type InteractionMode = 'camera' | 'model'

export interface CaptureSummary {
  id: string
  name: string
  basePath: string
  width: number
  height: number
  model: string
  serial: string
  xyPitchMm: number
  zUnitMm: number
  paletteMinMm: number
  paletteMaxMm: number
}

export interface ZagHeightField {
  capture: CaptureSummary
  heights: Int32Array
  mask: Uint8Array
  maskStride: number
  palette: Uint8Array
  color?: Uint8Array
  colorStride?: number
}

export interface ViewerModel {
  kind: 'zag' | 'stl'
  fileName: string
  label: string
  geometry: THREE.BufferGeometry
  palette: Uint8Array
  textureRgba?: Uint8ClampedArray
  textureWidth?: number
  textureHeight?: number
  widthMm: number
  lengthMm: number
  minHeightMm: number
  maxHeightMm: number
  suggestedMinMm: number
  suggestedMaxMm: number
  triangleCount: number
  originalPointCount: number
  renderedPointCount: number
  sampleStep: number
  heightAxis: [number, number, number]
  rotationX: number
  scaleOrder: 'zag' | 'stl'
  sectionSamples?: Float32Array
  sectionWidth?: number
  sectionCount?: number
  crossSections: Float32Array[]
  crossSectionX: Float32Array
  capture?: CaptureSummary
  warning?: string
}

export interface PointerSample {
  xMm: number
  yMm: number
  zMm: number
}

export interface PointMarker extends PointerSample {
  id: number
}
