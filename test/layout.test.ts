import { describe, expect, it } from 'vitest'
import { getPlayerLayout, renderProgressBar } from '../src/tui/layout.js'

describe('responsive player layout', () => {
  it('keeps compact terminals on the natural-height layout', () => {
    expect(getPlayerLayout(90, 26)).toEqual({
      expanded: false,
      height: undefined,
      progressWidth: 60,
      spectrumWidth: 82,
    })
  })

  it('uses the full terminal height and width on large windows', () => {
    expect(getPlayerLayout(200, 50)).toEqual({
      expanded: true,
      height: 50,
      progressWidth: 170,
      spectrumWidth: 192,
    })
  })

  it('eases the active progress cell between the track and played colors', () => {
    expect(renderProgressBar(0.5, 10)).toEqual({
      completedCells: 5,
      hasTransition: true,
      transitionIntensity: 0,
      remainingCells: 4,
    })
    expect(renderProgressBar(0.5125, 10)).toEqual({
      completedCells: 5,
      hasTransition: true,
      transitionIntensity: expect.closeTo(0.0381, 4),
      remainingCells: 4,
    })
  })

  it('clamps progress bar values to their valid range', () => {
    expect(renderProgressBar(-1, 4)).toEqual({
      completedCells: 0,
      hasTransition: false,
      transitionIntensity: 0,
      remainingCells: 4,
    })
    expect(renderProgressBar(2, 4)).toEqual({
      completedCells: 4,
      hasTransition: false,
      transitionIntensity: 0,
      remainingCells: 0,
    })
  })
})
