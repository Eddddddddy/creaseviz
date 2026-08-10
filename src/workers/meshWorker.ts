/// <reference lib="webworker" />

import { validateCalibrationValue, validateZagDimensions } from '../lib/fileLimits'

interface BuildMessage {
  type: 'build-zag'
  heights: ArrayBuffer
  mask: ArrayBuffer
  color?: ArrayBuffer
  width: number
  height: number
  maskStride: number
  colorStride?: number
  xyPitchMm: number
  zUnitMm: number
  targetVertices: number
}

interface TextureMessage {
  type: 'build-texture'
  color: ArrayBuffer
  width: number
  height: number
  colorStride: number
}

function sampleIndices(size: number, step: number): number[] {
  const values: number[] = []
  for (let value = 0; value < size; value += step) values.push(value)
  if (values.at(-1) !== size - 1) values.push(size - 1)
  return values
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))]
}

self.onmessage = (event: MessageEvent<BuildMessage | TextureMessage>) => {
  const message = event.data
  if (message.type === 'build-texture') {
    const dimensions = validateZagDimensions(message.width, message.height)
    if (message.colorStride !== dimensions.colorStride || message.color.byteLength !== dimensions.colorBytes) {
      throw new Error('ZAG 纹理缓冲区尺寸不匹配')
    }
    const color = new Uint8Array(message.color)
    const textureRgba = new Uint8ClampedArray(dimensions.heightBytes)
    for (let row = 0; row < message.height; row += 1) {
      for (let column = 0; column < message.width; column += 1) {
        const source = row * message.colorStride + column * 3
        const target = (row * message.width + column) * 4
        textureRgba[target] = color[source + 2]
        textureRgba[target + 1] = color[source + 1]
        textureRgba[target + 2] = color[source]
        textureRgba[target + 3] = 255
      }
    }
    self.postMessage({ type: 'texture-result', textureRgba: textureRgba.buffer }, { transfer: [textureRgba.buffer] })
    return
  }

  const dimensions = validateZagDimensions(message.width, message.height)
  if (message.heights.byteLength !== dimensions.heightBytes) throw new Error('ZAG 高度缓冲区尺寸不匹配')
  if (message.maskStride !== dimensions.maskStride || message.mask.byteLength !== dimensions.maskBytes) {
    throw new Error('ZAG 掩码缓冲区尺寸不匹配')
  }
  if (message.color) {
    if (message.colorStride !== dimensions.colorStride || message.color.byteLength !== dimensions.colorBytes) {
      throw new Error('ZAG 纹理缓冲区尺寸不匹配')
    }
  }
  validateCalibrationValue(message.xyPitchMm, 'XY ')
  validateCalibrationValue(message.zUnitMm, 'Z ')
  if (!Number.isSafeInteger(message.targetVertices) || message.targetVertices < 1 || message.targetVertices > 1_000_000) {
    throw new Error('目标网格点数无效')
  }

  const heights = new Int32Array(message.heights)
  const mask = new Uint8Array(message.mask)
  const color = message.color ? new Uint8Array(message.color) : undefined
  const step = Math.max(1, Math.ceil(Math.sqrt(dimensions.pixels / message.targetVertices)))
  const columns = sampleIndices(message.width, step)
  const rows = sampleIndices(message.height, step)
  const sampledWidth = columns.length
  const sampledHeight = rows.length
  const vertexCount = sampledWidth * sampledHeight
  const positions = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const scalars = new Float32Array(vertexCount)
  const valid = new Uint8Array(vertexCount)
  const finiteValues: number[] = []

  for (let rowIndex = 0; rowIndex < sampledHeight; rowIndex += 1) {
    const sourceRow = rows[rowIndex]
    for (let columnIndex = 0; columnIndex < sampledWidth; columnIndex += 1) {
      const sourceColumn = columns[columnIndex]
      const targetIndex = rowIndex * sampledWidth + columnIndex
      const sourceIndex = sourceRow * message.width + sourceColumn
      const heightMm = heights[sourceIndex] * message.zUnitMm
      const isValid = mask[sourceRow * message.maskStride + sourceColumn] !== 2
      positions[targetIndex * 3] = sourceColumn * message.xyPitchMm
      positions[targetIndex * 3 + 1] = heightMm
      positions[targetIndex * 3 + 2] = sourceRow * message.xyPitchMm
      uvs[targetIndex * 2] = sourceColumn / Math.max(1, message.width - 1)
      uvs[targetIndex * 2 + 1] = 1 - sourceRow / Math.max(1, message.height - 1)
      scalars[targetIndex] = isValid ? heightMm : Number.NaN
      valid[targetIndex] = isValid ? 1 : 0
      if (isValid) finiteValues.push(heightMm)
    }
  }

  const crossSectionRows = new Float32Array(message.height * sampledWidth)
  for (let sourceRow = 0; sourceRow < message.height; sourceRow += 1) {
    for (let columnIndex = 0; columnIndex < sampledWidth; columnIndex += 1) {
      const sourceColumn = columns[columnIndex]
      const sourceIndex = sourceRow * message.width + sourceColumn
      const isValid = mask[sourceRow * message.maskStride + sourceColumn] !== 2
      crossSectionRows[sourceRow * sampledWidth + columnIndex] = isValid
        ? heights[sourceIndex] * message.zUnitMm
        : Number.NaN
    }
  }

  const maxIndexCount = Math.max(0, (sampledWidth - 1) * (sampledHeight - 1) * 6)
  const indices = new Uint32Array(maxIndexCount)
  let indexCursor = 0
  for (let row = 0; row < sampledHeight - 1; row += 1) {
    for (let column = 0; column < sampledWidth - 1; column += 1) {
      const a = row * sampledWidth + column
      const b = a + 1
      const c = a + sampledWidth
      const d = c + 1
      if (valid[a] && valid[b] && valid[c]) {
        indices[indexCursor++] = a
        indices[indexCursor++] = c
        indices[indexCursor++] = b
      }
      if (valid[b] && valid[c] && valid[d]) {
        indices[indexCursor++] = b
        indices[indexCursor++] = c
        indices[indexCursor++] = d
      }
    }
  }

  finiteValues.sort((a, b) => a - b)
  const crossSections: ArrayBuffer[] = []
  const rowFractions = [0.25, 0.5, 0.75]
  for (const fraction of rowFractions) {
    const row = Math.min(sampledHeight - 1, Math.round((sampledHeight - 1) * fraction))
    crossSections.push(scalars.slice(row * sampledWidth, (row + 1) * sampledWidth).buffer)
  }
  const crossSectionX = new Float32Array(columns.map((column) => column * message.xyPitchMm))

  let textureRgba: Uint8ClampedArray | undefined
  if (color && message.colorStride) {
    textureRgba = new Uint8ClampedArray(sampledWidth * sampledHeight * 4)
    for (let rowIndex = 0; rowIndex < sampledHeight; rowIndex += 1) {
      const sourceRow = rows[rowIndex]
      for (let columnIndex = 0; columnIndex < sampledWidth; columnIndex += 1) {
        const sourceColumn = columns[columnIndex]
        const source = sourceRow * message.colorStride + sourceColumn * 3
        const target = (rowIndex * sampledWidth + columnIndex) * 4
        textureRgba[target] = color[source + 2]
        textureRgba[target + 1] = color[source + 1]
        textureRgba[target + 2] = color[source]
        textureRgba[target + 3] = 255
      }
    }
  }

  const result = {
    type: 'zag-mesh-result',
    positions: positions.buffer,
    uvs: uvs.buffer,
    scalars: scalars.buffer,
    crossSectionRows: crossSectionRows.buffer,
    indices: indices.slice(0, indexCursor).buffer,
    crossSections,
    crossSectionX: crossSectionX.buffer,
    textureRgba: textureRgba?.buffer,
    textureWidth: textureRgba ? sampledWidth : undefined,
    textureHeight: textureRgba ? sampledHeight : undefined,
    sampledWidth,
    sampledHeight,
    sampleStep: step,
    validPointCount: finiteValues.length,
    minHeightMm: finiteValues[0] ?? 0,
    maxHeightMm: finiteValues.at(-1) ?? 0,
    suggestedMinMm: percentile(finiteValues, 0.01),
    suggestedMaxMm: percentile(finiteValues, 0.99),
    triangleCount: indexCursor / 3,
  }
  const transfers: Transferable[] = [
    result.positions,
    result.uvs,
    result.scalars,
    result.crossSectionRows,
    result.indices,
    result.crossSectionX,
    ...crossSections,
  ]
  if (result.textureRgba) transfers.push(result.textureRgba)
  self.postMessage(result, { transfer: transfers })
}

export {}
