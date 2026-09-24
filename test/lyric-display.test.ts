import { describe, expect, it } from 'vitest'
import {
  lyricMainText,
  lyricPositionOf,
  lyricSubText,
  nextLyricDisplayMode,
  stepLyricOffset,
  useWordTiming,
} from '../src/tui/lyric-display.js'
import { sanitizeConfigPatch } from '../src/core/config.js'
import type { LyricLine, LyricView } from '../src/core/types.js'

const line: LyricLine = {
  time: 1,
  endTime: 4,
  text: '晴天',
  translation: 'Sunny',
  romanization: 'qing tian',
  words: [
    { startTime: 1, endTime: 2.5, text: '晴' },
    { startTime: 2.5, endTime: 4, text: '天' },
  ],
}

const view = (overrides: Partial<LyricView> = {}): LyricView => ({
  mode: 'both',
  karaoke: true,
  background: true,
  offsetMs: 0,
  ...overrides,
})

describe('lyricMainText', () => {
  it('原文与双语模式都显示原文', () => {
    expect(lyricMainText(line, 'original')).toBe('晴天')
    expect(lyricMainText(line, 'both')).toBe('晴天')
  })

  it('译文与罗马音模式取对应语言层', () => {
    expect(lyricMainText(line, 'translation')).toBe('Sunny')
    expect(lyricMainText(line, 'romanization')).toBe('qing tian')
  })

  it('缺少对应语言层时回退原文', () => {
    const bare: LyricLine = { time: 0, endTime: 1, text: '只有原文' }
    expect(lyricMainText(bare, 'translation')).toBe('只有原文')
    expect(lyricMainText(bare, 'romanization')).toBe('只有原文')
    expect(lyricMainText(undefined, 'translation')).toBe('')
  })

  it('空白的语言层不会顶替原文', () => {
    const blank: LyricLine = { time: 0, endTime: 1, text: '原文', translation: '   ' }
    expect(lyricMainText(blank, 'translation')).toBe('原文')
  })
})

describe('lyricSubText', () => {
  it('只有双语模式产生附加行，且优先译文', () => {
    expect(lyricSubText(line, 'both')).toBe('Sunny')
    expect(lyricSubText(line, 'original')).toBe('')
    expect(lyricSubText(line, 'translation')).toBe('')
  })

  it('没有译文时双语模式退化为罗马音', () => {
    const withoutTranslation: LyricLine = { time: 0, endTime: 1, text: 'a', romanization: 'r' }
    expect(lyricSubText(withoutTranslation, 'both')).toBe('r')
    expect(lyricSubText({ time: 0, endTime: 1, text: 'a' }, 'both')).toBe('')
  })
})

describe('useWordTiming', () => {
  it('逐字高亮需要逐字时间轴且显示的是原文', () => {
    expect(useWordTiming(line, view(), '晴天')).toBe(true)
    expect(useWordTiming(line, view(), 'Sunny')).toBe(false)
  })

  it('关闭 karaoke 或缺少逐字数据时按整行显示', () => {
    expect(useWordTiming(line, view({ karaoke: false }), '晴天')).toBe(false)
    expect(useWordTiming({ time: 0, endTime: 1, text: 'a' }, view(), 'a')).toBe(false)
  })

  it('没有歌词视图时保持逐字行为', () => {
    expect(useWordTiming(line, undefined, '晴天')).toBe(true)
  })
})

describe('歌词偏移', () => {
  it('偏移只作用于歌词位置且不会为负', () => {
    expect(lyricPositionOf(10, 250)).toBeCloseTo(10.25, 6)
    expect(lyricPositionOf(10, -250)).toBeCloseTo(9.75, 6)
    expect(lyricPositionOf(0.1, -250)).toBe(0)
  })

  it('步进被收敛到 ±60 秒', () => {
    expect(stepLyricOffset(0, 250, 60_000)).toBe(250)
    expect(stepLyricOffset(59_900, 250, 60_000)).toBe(60_000)
    expect(stepLyricOffset(-59_900, -250, 60_000)).toBe(-60_000)
  })

  it('显示模式按固定顺序循环', () => {
    expect(nextLyricDisplayMode('original')).toBe('both')
    expect(nextLyricDisplayMode('both')).toBe('translation')
    expect(nextLyricDisplayMode('translation')).toBe('romanization')
    expect(nextLyricDisplayMode('romanization')).toBe('original')
  })
})

describe('歌词显示配置校验', () => {
  it('接受新的显示字段并取整偏移', () => {
    expect(
      sanitizeConfigPatch({
        lyrics: { display: 'translation', karaoke: false, background: false, offsetMs: -250.4 },
      }),
    ).toEqual({
      lyrics: { display: 'translation', karaoke: false, background: false, offsetMs: -250 },
    })
  })

  it('拒绝未知显示模式与越界偏移', () => {
    expect(() => sanitizeConfigPatch({ lyrics: { display: 'karaoke' } })).toThrow(/lyrics.display/)
    expect(() => sanitizeConfigPatch({ lyrics: { offsetMs: 90_000 } })).toThrow(/60000/)
  })

  it('保留旧字段校验不受影响', () => {
    expect(sanitizeConfigPatch({ lyrics: { upgrade: false } })).toEqual({
      lyrics: { upgrade: false },
    })
  })
})
