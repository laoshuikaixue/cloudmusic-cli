import { describe, expect, it } from 'vitest'
import {
  findLyricIndex,
  mergeLyrics,
  parseLrc,
  parseQrc,
  parseTtml,
  parseYrc,
} from '../src/core/lyrics.js'
import { evaluateLyricMatch } from '../src/core/lyric-match.js'

describe('lyric parsing', () => {
  it('parses LRC timestamps and derives line end times', () => {
    const lines = parseLrc('[00:02.50]second\n[00:01.000]first')
    expect(lines).toEqual([
      { time: 1, endTime: 2.5, text: 'first' },
      { time: 2.5, endTime: 7.5, text: 'second' },
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

  it('preserves NetEase YRC word timing', () => {
    expect(parseYrc('[59610,1950](59610,450,0)In (60060,420,0)my (60480,900,0)dreams')).toEqual([
      {
        time: 59.61,
        endTime: 61.56,
        text: 'In my dreams',
        words: [
          { startTime: 59.61, endTime: 60.06, text: 'In ' },
          { startTime: 60.06, endTime: 60.48, text: 'my ' },
          { startTime: 60.48, endTime: 61.38, text: 'dreams' },
        ],
      },
    ])
  })

  it('parses QQ Music QRC word timing', () => {
    expect(parseQrc('[1000,1200]你(1000,400)好(1400,800)')).toEqual([
      {
        time: 1,
        endTime: 2.2,
        text: '你好',
        words: [
          { startTime: 1, endTime: 1.4, text: '你' },
          { startTime: 1.4, endTime: 2.2, text: '好' },
        ],
      },
    ])
  })

  it('parses TTML words, duet agents, translations and background vocals', () => {
    const lines = parseTtml(`
      <tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
        <body><div>
          <p begin="1s" end="3s" ttm:agent="v1">
            <span begin="1s" end="2s">Hello </span><span begin="2s" end="3s">world</span>
            <span ttm:role="x-translation">你好世界</span>
            <span ttm:role="x-bg" begin="1.5s" end="2.5s"><span begin="1.5s" end="2.5s">(echo)</span></span>
          </p>
          <p begin="3s" end="4s" ttm:agent="v2">
            <span begin="3s" end="4s">Reply</span>
            <span ttm:role="x-bg" begin="3.2s" end="3.8s"><span begin="3.2s" end="3.8s">(right echo)</span></span>
          </p>
        </div></body>
      </tt>
    `)
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Hello world', translation: '你好世界', isDuet: false }),
        expect.objectContaining({ text: '(echo)', isBackground: true }),
        expect.objectContaining({ text: 'Reply', isDuet: true }),
        expect.objectContaining({ text: '(right echo)', isBackground: true, isDuet: true }),
      ]),
    )
  })

  it('uses declared TTML primary agent even when the duet singer appears first', () => {
    const lines = parseTtml(`
      <tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
        <head><metadata>
          <ttm:agent type="person" xml:id="v1" />
          <ttm:agent type="other" xml:id="v2" />
        </metadata></head>
        <body><div>
          <p begin="1s" end="2s" ttm:agent="v2"><span begin="1s" end="2s">right</span></p>
          <p begin="2s" end="3s" ttm:agent="v1"><span begin="2s" end="3s">left</span></p>
        </div></body>
      </tt>
    `)
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'right', isDuet: true }),
        expect.objectContaining({ text: 'left', isDuet: false }),
      ]),
    )
  })

  it('falls back to LRC when YRC contains only metadata', () => {
    const lines = mergeLyrics({
      yrc: { lyric: '{"t":0,"c":[{"tx":"作词"}]}' },
      lrc: { lyric: '[00:01.00]fallback' },
    })
    expect(lines).toEqual([{ time: 1, endTime: 6, text: 'fallback' }])
  })
})

describe('lyric upgrade validation', () => {
  const reference = parseLrc(
    '[00:01.00]first line\n[00:10.00]second line\n[00:20.00]third line\n[00:30.00]fourth line\n[00:40.00]fifth line\n[00:50.00]sixth line',
  )

  it('accepts matching content with a close time axis', () => {
    const candidate = parseQrc(
      '[1100,1000]first line(1100,1000)\n[10100,1000]second line(10100,1000)\n[20100,1000]third line(20100,1000)\n[30100,1000]fourth line(30100,1000)\n[40100,1000]fifth line(40100,1000)\n[50100,1000]sixth line(50100,1000)',
    )
    expect(evaluateLyricMatch(reference, candidate, 55_000, 55_000).status).toBe('accepted')
  })

  it('rejects a same-title adapted version with different content', () => {
    const candidate = parseLrc(
      '[00:01.00]unrelated\n[00:10.00]different\n[00:20.00]adapted\n[00:30.00]words\n[00:40.00]new melody\n[00:50.00]version',
    )
    expect(evaluateLyricMatch(reference, candidate, 55_000, 55_000)).toMatchObject({
      status: 'rejected',
      reason: 'content_mismatch',
    })
  })
})
