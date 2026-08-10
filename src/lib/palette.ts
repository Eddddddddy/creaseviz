const STOPS: Array<[number, [number, number, number]]> = [
  [0, [34, 55, 202]],
  [0.18, [0, 159, 226]],
  [0.38, [0, 190, 143]],
  [0.58, [154, 213, 35]],
  [0.76, [255, 205, 35]],
  [0.9, [248, 93, 35]],
  [1, [173, 24, 38]],
]

export function createScientificPalette(): Uint8Array {
  const result = new Uint8Array(256 * 3)
  for (let index = 0; index < 256; index += 1) {
    const t = index / 255
    const upperIndex = STOPS.findIndex(([position]) => position >= t)
    const high = STOPS[Math.max(1, upperIndex)]
    const low = STOPS[Math.max(0, Math.max(1, upperIndex) - 1)]
    const amount = (t - low[0]) / Math.max(1e-9, high[0] - low[0])
    for (let channel = 0; channel < 3; channel += 1) {
      result[index * 3 + channel] = Math.round(
        low[1][channel] + (high[1][channel] - low[1][channel]) * amount,
      )
    }
  }
  return result
}

export function paletteCss(palette: Uint8Array): string {
  const marks = [0, 32, 64, 96, 128, 160, 192, 224, 255]
  return `linear-gradient(to top, ${marks
    .map((index) => {
      const offset = index * 3
      return `rgb(${palette[offset]}, ${palette[offset + 1]}, ${palette[offset + 2]}) ${(index / 255) * 100}%`
    })
    .join(', ')})`
}
