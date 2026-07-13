import { describe, expect, it } from 'vitest'
import { getPlayerLayout } from '../src/tui/layout.js'

describe('responsive player layout', () => {
  it('keeps compact terminals on the natural-height layout', () => {
    expect(getPlayerLayout(90, 26)).toEqual({
      expanded: false,
      height: undefined,
      mainGap: 0,
      progressWidth: 60,
      spectrumWidth: 82,
    })
  })

  it('uses the full terminal height and width on large windows', () => {
    expect(getPlayerLayout(200, 50)).toEqual({
      expanded: true,
      height: 50,
      mainGap: 6,
      progressWidth: 170,
      spectrumWidth: 192,
    })
  })
})
