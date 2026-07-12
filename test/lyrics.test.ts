import { describe, expect, it } from 'vitest'
import { findLyricIndex, mergeLyrics, parseLrc } from '../src/core/lyrics.js'

describe('parseLrc', () => {
  it('parses timestamps and sorts lines', () => {
    const lines = parseLrc('[00:02.50]second\n[00:01.000]first')
    expect(lines).toEqual([
      { time: 1, text: 'first' },
      { time: 2.5, text: 'second' },
    ])
  })

  it('aligns translations', () => {
    const lines = mergeLyrics({
      lrc: { lyric: '[00:01.00]hello' },
      tlyric: { lyric: '[00:01.10]你好' },
    })
    expect(lines[0]).toMatchObject({ text: 'hello', translation: '你好' })
    expect(findLyricIndex(lines, 1.2)).toBe(0)
  })
})
