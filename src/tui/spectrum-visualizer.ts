const clamp = (value: number) => Math.max(0, Math.min(1, value))

export const smoothSpectrumBins = (
  current: readonly number[],
  target: readonly number[],
  attack = 0.42,
  release = 0.16,
) => {
  const length = Math.max(current.length, target.length)
  const spatial = Array.from({ length }, (_, index) => {
    const left = target[Math.max(0, index - 1)] || 0
    const center = target[index] || 0
    const right = target[Math.min(target.length - 1, index + 1)] || 0
    return clamp(left * 0.2 + center * 0.6 + right * 0.2)
  })
  return spatial.map((value, index) => {
    const previous = current[index] || 0
    const factor = value >= previous ? attack : release
    return clamp(previous + (value - previous) * factor)
  })
}

export const resampleSpectrumBins = (bins: readonly number[], count: number) => {
  if (count <= 0) return []
  if (!bins.length) return new Array(count).fill(0) as number[]
  if (count === 1) return [bins[0] || 0]
  return Array.from({ length: count }, (_, index) => {
    const source = (index / (count - 1)) * (bins.length - 1)
    const left = Math.floor(source)
    const right = Math.min(bins.length - 1, left + 1)
    const fraction = source - left
    return clamp((bins[left] || 0) * (1 - fraction) + (bins[right] || 0) * fraction)
  })
}

const brailleBit = (x: number, y: number) => {
  if (x === 0) return [0, 1, 2, 6][y] || 0
  return [3, 4, 5, 7][y] || 0
}

const brailleCharacter = (left: number, right: number, rowOffset: 0 | 4) => {
  let bits = 0
  for (const [x, value] of [left, right].entries()) {
    const halfHeight = Math.ceil(clamp(value) * 4)
    if (!halfHeight) continue
    const from = 4 - halfHeight
    const to = 3 + halfHeight
    for (let y = rowOffset; y < rowOffset + 4; y += 1) {
      if (y >= from && y <= to) bits |= 1 << brailleBit(x, y - rowOffset)
    }
  }
  return bits ? String.fromCodePoint(0x2800 + bits) : ' '
}

/** 将频带渲染为两行上下对称的 Braille 波形，每列字符承载两个水平采样点。 */
export const renderBrailleSpectrum = (bins: readonly number[], columns: number) => {
  const width = Math.max(1, Math.floor(columns))
  const samples = resampleSpectrumBins(bins, width * 2)
  let top = ''
  let bottom = ''
  for (let column = 0; column < width; column += 1) {
    const left = samples[column * 2] || 0
    const right = samples[column * 2 + 1] || 0
    top += brailleCharacter(left, right, 0)
    bottom += brailleCharacter(left, right, 4)
  }
  return [top, bottom] as const
}
