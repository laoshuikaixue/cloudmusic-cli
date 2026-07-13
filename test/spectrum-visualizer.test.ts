import { describe, expect, it } from 'vitest'
import {
  isSpectrumFrameSynchronized,
  renderSpectrumBars,
  resampleSpectrumBins,
  smoothSpectrumBins,
} from '../src/tui/spectrum-visualizer.js'

describe('terminal spectrum visualizer', () => {
  it('accepts frames from the current analyzer generation after seeking', () => {
    expect(isSpectrumFrameSynchronized(20, 22, 3, 3)).toBe(true)
    expect(isSpectrumFrameSynchronized(22, 22, 2, 3)).toBe(false)
    expect(isSpectrumFrameSynchronized(22, 22.2)).toBe(true)
    expect(isSpectrumFrameSynchronized(22, 23)).toBe(false)
  })

  it('smooths neighboring frequencies and uses slower release than attack', () => {
    const attack = smoothSpectrumBins([0, 0, 0], [0, 1, 0])
    expect(attack[1]).toBeGreaterThan(attack[0] || 0)
    expect(attack[0]).toBeGreaterThan(0)
    const release = smoothSpectrumBins(attack, [0, 0, 0])
    expect(release[1]).toBeGreaterThan(0)
    expect(release[1]).toBeLessThan(attack[1] || 0)
  })

  it('linearly resamples real frequency bins to the available terminal width', () => {
    expect(resampleSpectrumBins([0, 1], 3)).toEqual([0, 0.5, 1])
  })

  it('renders spectrum columns upward from the bottom baseline', () => {
    expect(renderSpectrumBars([0, 0], 3)).toEqual(['   ', '   '])
    const lowEnergy = renderSpectrumBars([0.25, 0.25], 3)
    expect(lowEnergy[0]).toBe('   ')
    expect(lowEnergy[1].trim()).not.toBe('')
    expect(renderSpectrumBars([1, 1], 3)).toEqual(['█ █', '█ █'])
  })
})
