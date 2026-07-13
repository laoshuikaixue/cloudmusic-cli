const clamp = (value: number) => Math.max(0, Math.min(1, value))

export const isSpectrumFrameSynchronized = (
  framePosition: number,
  playbackPosition: number,
  frameGeneration?: number,
  playbackGeneration?: number,
) => {
  if (frameGeneration !== undefined && playbackGeneration !== undefined) {
    return frameGeneration === playbackGeneration
  }
  return Math.abs(framePosition - playbackPosition) < 0.4
}

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

const blockLevels = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

const blockForUnits = (units: number) => blockLevels[Math.max(0, Math.min(8, Math.round(units)))]!

/** 将真实 PCM 频带渲染为带间隔、从底部向上生长的双层实心柱。 */
export const renderSpectrumBars = (bins: readonly number[], columns: number) => {
  const width = Math.max(1, Math.floor(columns))
  const barCount = Math.max(1, Math.floor((width + 1) / 2))
  const samples = resampleSpectrumBins(bins, barCount)
  const heights = samples.map((value) => Math.pow(clamp(value), 0.85) * 16)
  const top = heights.map((height) => blockForUnits(Math.max(0, height - 8))).join(' ')
  const bottom = heights.map((height) => blockForUnits(Math.min(8, height))).join(' ')
  return [top.padEnd(width), bottom.padEnd(width)] as const
}
