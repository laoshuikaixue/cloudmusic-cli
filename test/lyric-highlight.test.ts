import { describe, expect, it } from 'vitest'
import {
  easeInOutSine,
  interpolateWordGraphemes,
  mixHexColors,
  splitGraphemes,
} from '../src/tui/lyric-highlight.js'

describe('lyric character highlight', () => {
  it('keeps Unicode grapheme clusters intact', () => {
    expect(splitGraphemes('你a\u0301😊')).toEqual(['你', 'a\u0301', '😊'])
  })

  it('interpolates a word time slice into character brightness phases', () => {
    const result = interpolateWordGraphemes('逐字效果', 10, 12, 10.75)
    expect(result.map((item) => item.phase)).toEqual([
      'completed',
      'active',
      'upcoming',
      'upcoming',
    ])
    expect(result[1]?.brightness).toBeCloseTo(0.5)
  })

  it('does not let whitespace consume a visible character time slice', () => {
    const result = interpolateWordGraphemes('A B', 0, 1, 0.75)
    expect(result[0]).toMatchObject({ phase: 'completed', startTime: 0, endTime: 0.5 })
    expect(result[1]).toMatchObject({ text: ' ', startTime: 0.5, endTime: 0.5 })
    expect(result[2]).toMatchObject({ phase: 'active', startTime: 0.5, endTime: 1 })
  })

  it('uses a smooth easing curve and continuous true-color interpolation', () => {
    expect(easeInOutSine(0.25)).toBeCloseTo(0.1464, 4)
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5)
    expect(mixHexColors('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHexColors('#475569', '#22d3ee', 0)).toBe('#475569')
    expect(mixHexColors('#475569', '#22d3ee', 1)).toBe('#22d3ee')
  })
})
