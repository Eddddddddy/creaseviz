import type { HeightMetrics } from './assessmentTypes'

export function quantileSorted(values: ArrayLike<number>, p: number): number {
  if (!values.length) return NaN
  const position = (values.length - 1) * p
  const i = Math.floor(position), j = Math.ceil(position)
  return values[i] + (values[j] - values[i]) * (position - i)
}

export function finiteSorted(values: ArrayLike<number>): Float64Array {
  const buffer = new Float64Array(values.length)
  let n = 0
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) buffer[n++] = values[i]
  return buffer.slice(0, n).sort()
}

function solve3(matrix: number[][]): number[] {
  for (let column = 0; column < 3; column++) {
    let pivot = column
    for (let row = column + 1; row < 3; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row
    if (Math.abs(matrix[pivot][column]) < 1e-12) throw new Error('有效点不能确定二维基准平面，请扩大选区或检查缺测')
    ;[matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]]
    const divisor = matrix[column][column]
    for (let i = column; i < 4; i++) matrix[column][i] /= divisor
    for (let row = 0; row < 3; row++) {
      if (row === column) continue
      const multiple = matrix[row][column]
      for (let i = column; i < 4; i++) matrix[row][i] -= multiple * matrix[column][i]
    }
  }
  return matrix.map((row) => row[3])
}

/** Stable centered/scaled OLS or six Huber IRLS iterations. Coordinates are mm. */
export function fitAssessmentPlane(values: Float64Array, xs: Float64Array, ys: Float64Array,
  robust = false): [number, number, number] {
  const cx = (xs[0] + xs[xs.length - 1]) / 2, cy = (ys[0] + ys[ys.length - 1]) / 2
  const sx = xs[xs.length - 1] - xs[0], sy = ys[ys.length - 1] - ys[0]
  if (!(sx > 0 && sy > 0)) throw new Error('选区过窄，至少需要 3×3 个分析网格')
  let coefficients = [0, 0, 0]
  let weights: Float64Array | undefined
  for (let iteration = 0; iteration < (robust ? 6 : 1); iteration++) {
    let n = 0, xx = 0, xy = 0, yy = 0, x = 0, y = 0, xz = 0, yz = 0, z = 0
    for (let row = 0; row < ys.length; row++) {
      const v = (ys[row] - cy) / sy
      for (let col = 0; col < xs.length; col++) {
        const i = row * xs.length + col, h = values[i]
        if (!Number.isFinite(h)) continue
        const u = (xs[col] - cx) / sx, w = weights?.[i] ?? 1
        n += w; xx += w * u * u; xy += w * u * v; yy += w * v * v
        x += w * u; y += w * v; xz += w * u * h; yz += w * v * h; z += w * h
      }
    }
    if (n < 3) throw new Error('选区内有效数据不足，无法拟合平面')
    coefficients = solve3([[xx, xy, x, xz], [xy, yy, y, yz], [x, y, n, z]])
    if (robust && iteration < 5) {
      const residuals = new Float64Array(values.length).fill(NaN)
      for (let row = 0; row < ys.length; row++) for (let col = 0; col < xs.length; col++) {
        const i = row * xs.length + col
        residuals[i] = values[i] - coefficients[0] * (xs[col] - cx) / sx - coefficients[1] * (ys[row] - cy) / sy - coefficients[2]
      }
      const median = quantileSorted(finiteSorted(residuals), 0.5)
      const deviations = Float64Array.from(residuals, (r) => Math.abs(r - median))
      const scale = Math.max(1e-9, quantileSorted(finiteSorted(deviations), 0.5) * 1.4826)
      weights = Float64Array.from(residuals, (r) => Math.min(1, 1.5 * scale / Math.max(1e-15, Math.abs(r - median))))
    }
  }
  const a = coefficients[0] / sx, b = coefficients[1] / sy
  return [a, b, coefficients[2] - a * cx - b * cy]
}

/** Plane-normal distances in mm. No height trimming or percentile exclusion. */
export function residualField(values: Float64Array, xs: Float64Array, ys: Float64Array, plane: number[], normal = true): Float64Array {
  const denominator = normal ? Math.hypot(1, plane[0], plane[1]) : 1
  return Float64Array.from(values, (z, i) => (z - plane[0] * xs[i % xs.length] - plane[1] * ys[Math.floor(i / xs.length)] - plane[2]) / denominator)
}

export function heightMetrics(values: Float64Array): HeightMetrics {
  const sorted = finiteSorted(values)
  if (!sorted.length) throw new Error('当前范围内没有可评估的有效数据')
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0
  for (const mm of sorted) {
    const v = mm * 1000, vv = v * v
    s1 += Math.abs(v); s2 += vv; s3 += vv * v; s4 += vv * vv
  }
  const n = sorted.length, rms = Math.sqrt(s2 / n)
  return { count: n, rmsUm: rms, meanAbsUm: s1 / n,
    pvUm: (sorted[n - 1] - sorted[0]) * 1000,
    f98Um: (quantileSorted(sorted, .99) - quantileSorted(sorted, .01)) * 1000,
    f90Um: (quantileSorted(sorted, .95) - quantileSorted(sorted, .05)) * 1000,
    peakUm: Math.max(0, sorted[n - 1] * 1000), pitUm: Math.max(0, -sorted[0] * 1000),
    skewness: rms > 1e-8 ? s3 / n / rms ** 3 : null,
    kurtosis: rms > 1e-8 ? s4 / n / rms ** 4 : null }
}

function kernel(sigmaPx: number): Float64Array {
  if (sigmaPx <= 0) return new Float64Array([1])
  const radius = Math.min(256, Math.ceil(3 * sigmaPx))
  const weights = Float64Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigmaPx) ** 2))
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => w / sum)
}

function convolve(input: Float64Array, nx: number, ny: number, weights: Float64Array, horizontal: boolean): Float64Array {
  const out = new Float64Array(input.length), radius = (weights.length - 1) / 2
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let sum = 0
    for (let delta = -radius; delta <= radius; delta++) {
      const xx = horizontal ? Math.max(0, Math.min(nx - 1, x + delta)) : x
      const yy = horizontal ? y : Math.max(0, Math.min(ny - 1, y + delta))
      sum += input[yy * nx + xx] * weights[delta + radius]
    }
    out[y * nx + x] = sum
  }
  return out
}

/** Normalized convolution; invalid centers remain invalid (never filled as zero). */
export function gaussianField(input: Float64Array, nx: number, ny: number, sigmaX: number, sigmaY: number): Float64Array {
  if (sigmaX === 0 && sigmaY === 0) return input.slice()
  let numerator: Float64Array = Float64Array.from(input, (v) => Number.isFinite(v) ? v : 0)
  let density: Float64Array = Float64Array.from(input, (v) => Number.isFinite(v) ? 1 : 0)
  for (const horizontal of [true, false]) {
    const weights = kernel(horizontal ? sigmaX : sigmaY)
    numerator = convolve(numerator, nx, ny, weights, horizontal)
    density = convolve(density, nx, ny, weights, horizontal)
  }
  return Float64Array.from(input, (value, i) => Number.isFinite(value) && density[i] >= .99 ? numerator[i] / density[i] : NaN)
}

export function gaussianProfile(input: Float64Array, sigmaPx: number): Float64Array {
  return gaussianField(input, input.length, 1, sigmaPx, 0)
}
