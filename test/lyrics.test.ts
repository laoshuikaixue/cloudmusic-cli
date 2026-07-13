import { describe, expect, it } from 'vitest'
import { findLyricIndex, mergeLyrics, parseLrc, parseYrc } from '../src/core/lyrics.js'

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

  it('parses NetEase word-timed YRC lines', () => {
    expect(
      parseYrc('[59610,1950](59610,450,0)In (60060,420,0)my (60480,900,0)dreams(61380,180,0) '),
    ).toEqual([{ time: 59.61, text: 'In my dreams' }])
  })

  it('falls back to LRC when YRC contains only metadata', () => {
    const lines = mergeLyrics({
      yrc: { lyric: '{"t":0,"c":[{"tx":"作词"}]}' },
      lrc: { lyric: '[00:01.00]fallback' },
    })
    expect(lines).toEqual([{ time: 1, text: 'fallback' }])
  })
})
