import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

interface CompiledHeightShader extends THREE.WebGLProgramParametersWithUniforms {
  uniforms: THREE.WebGLProgramParametersWithUniforms['uniforms'] & {
    uTextureMix: { value: number }
    uPaletteBrightness: { value: number }
  }
}

interface HeightMaterialProps {
  geometry: THREE.BufferGeometry
  palette: Uint8Array
  minHeight: number
  maxHeight: number
  heightAxis: [number, number, number]
  usesHeightAttribute: boolean
  surfaceTexture?: THREE.Texture
  textureMix: number
  paletteBrightness: number
  opacity?: number
}

function createLinearPalette(palette: Uint8Array): Float32Array {
  const result = new Float32Array(256 * 3)
  const color = new THREE.Color()
  for (let index = 0; index < 256; index += 1) {
    color.setRGB(
      (palette[index * 3] ?? 0) / 255,
      (palette[index * 3 + 1] ?? 0) / 255,
      (palette[index * 3 + 2] ?? 0) / 255,
      THREE.SRGBColorSpace,
    )
    result[index * 3] = color.r
    result[index * 3 + 1] = color.g
    result[index * 3 + 2] = color.b
  }
  return result
}

export default function HeightMaterial({
  geometry,
  palette,
  minHeight,
  maxHeight,
  heightAxis,
  usesHeightAttribute,
  surfaceTexture,
  textureMix,
  paletteBrightness,
  opacity = 1,
}: HeightMaterialProps) {
  const linearPalette = useMemo(() => createLinearPalette(palette), [palette])

  useMemo(() => {
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute
    const heights = geometry.getAttribute('heightValue') as THREE.BufferAttribute | undefined
    const colors = new Float32Array(positions.count * 3)
    const range = Math.max(1e-9, maxHeight - minHeight)
    const [axisX, axisY, axisZ] = heightAxis

    for (let index = 0; index < positions.count; index += 1) {
      const height = usesHeightAttribute && heights
        ? heights.getX(index)
        : positions.getX(index) * axisX + positions.getY(index) * axisY + positions.getZ(index) * axisZ
      const paletteIndex = Math.min(255, Math.max(0, Math.round(((height - minHeight) / range) * 255)))
      colors[index * 3] = linearPalette[paletteIndex * 3]
      colors[index * 3 + 1] = linearPalette[paletteIndex * 3 + 1]
      colors[index * 3 + 2] = linearPalette[paletteIndex * 3 + 2]
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }, [geometry, heightAxis, linearPalette, maxHeight, minHeight, usesHeightAttribute])

  const material = useMemo(() => {
    const value = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      map: surfaceTexture ?? null,
      roughness: 0.72,
      metalness: 0.015,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity,
    })

    value.onBeforeCompile = (shader) => {
      const compiled = shader as CompiledHeightShader
      compiled.uniforms.uTextureMix = { value: textureMix }
      compiled.uniforms.uPaletteBrightness = { value: paletteBrightness }
      compiled.fragmentShader = compiled.fragmentShader
        .replace(
          'void main() {',
          `uniform float uTextureMix;
           uniform float uPaletteBrightness;
           void main() {`,
        )
        .replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
             vec4 sampledDiffuseColor = texture2D(map, vMapUv);
             float surfaceLuminance = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
             float surfaceTone = 0.72 + surfaceLuminance * 0.56;
             diffuseColor.rgb *= mix(1.0, surfaceTone, uTextureMix);
             diffuseColor.a *= sampledDiffuseColor.a;
           #endif`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           diffuseColor.rgb *= uPaletteBrightness;`,
        )
      value.userData.compiledShader = compiled
    }
    value.customProgramCacheKey = () => `height-pbr-v2-${surfaceTexture ? 'texture' : 'plain'}`
    return value
  }, [opacity, paletteBrightness, surfaceTexture, textureMix])

  useEffect(() => {
    const shader = material.userData.compiledShader as CompiledHeightShader | undefined
    if (shader) {
      shader.uniforms.uTextureMix.value = textureMix
      shader.uniforms.uPaletteBrightness.value = paletteBrightness
    }
    material.opacity = opacity
    material.transparent = opacity < 1
  }, [material, opacity, paletteBrightness, textureMix])

  useEffect(() => () => material.dispose(), [material])

  return <primitive object={material} attach="material" />
}
