import { describe, expect, it } from 'vitest'
import {
  renderBrailleSpectrum,
  resampleSpectrumBins,
  smoothSpectrumBins,
} from '../src/tui/spectrum-visualizer.js'

describe('terminal spectrum visualizer', () => {
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

  it('renders silence and full-scale energy as a two-line symmetric Braille band', () => {
    expect(renderBrailleSpectrum([0, 0], 2)).toEqual(['  ', '  '])
    expect(renderBrailleSpectrum([1, 1], 2)).toEqual(['⣿⣿', '⣿⣿'])
  })
})
