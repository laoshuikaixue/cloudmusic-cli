import { describe, expect, it } from 'vitest'
import {
  addListenedSeconds,
  emptyLocalStats,
  localDateKey,
  localStatsWindow,
  pruneLocalStats,
  summarizeLocalStats,
} from '../src/core/local-stats.js'
import type { Song } from '../src/core/types.js'

const song = (id: number, name = `歌${id}`): Song => ({
  id,
  name,
  artists: [{ name: '歌手' }],
  album: { name: '专辑' },
  duration: 180_000,
})

/** 用本地时区字段构造时刻，断言不受运行机器时区影响 */
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0).getTime()

describe('localDateKey', () => {
  it('返回本地日历日期', () => {
    expect(localDateKey(at(2026, 1, 5, 23, 0))).toBe('2026-01-05')
    expect(localDateKey(at(2026, 12, 31, 23, 59))).toBe('2026-12-31')
  })

  it('跨日界按本地时间而不是 UTC 切分', () => {
    // UTC+8 时，UTC 的 16:30 已是本地次日
    const lateEvening = new Date(2026, 0, 5, 23, 30).getTime()
    expect(localDateKey(lateEvening)).toBe('2026-01-05')
  })

  it('非法时间戳退回当前时间而不是崩溃', () => {
    expect(localDateKey(Number.NaN)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('addListenedSeconds', () => {
  it('按天按歌曲累计', () => {
    let stats = emptyLocalStats()
    stats = addListenedSeconds(stats, song(1), 60, at(2026, 1, 5))
    stats = addListenedSeconds(stats, song(1), 30, at(2026, 1, 5))
    stats = addListenedSeconds(stats, song(1), 20, at(2026, 1, 6))
    expect(stats.days['2026-01-05']?.['1']).toBe(90)
    expect(stats.days['2026-01-06']?.['1']).toBe(20)
    expect(stats.songs['1']).toEqual({ id: 1, name: '歌1', artists: ['歌手'], album: '专辑' })
  })

  it('非正数与非法值不产生记录', () => {
    const stats = emptyLocalStats()
    expect(addListenedSeconds(stats, song(1), 0, at(2026, 1, 5))).toBe(stats)
    expect(addListenedSeconds(stats, song(1), -10, at(2026, 1, 5))).toBe(stats)
    expect(addListenedSeconds(stats, song(1), Number.NaN, at(2026, 1, 5))).toBe(stats)
  })

  it('不修改传入的对象', () => {
    const stats = emptyLocalStats()
    addListenedSeconds(stats, song(1), 10, at(2026, 1, 5))
    expect(stats.days).toEqual({})
  })
})

describe('pruneLocalStats', () => {
  const build = () => {
    let stats = emptyLocalStats()
    for (const day of [4, 5, 6, 7])
      stats = addListenedSeconds(stats, song(day), 10, at(2026, 1, day))
    return stats
  }

  it('只保留最近若干天', () => {
    const pruned = pruneLocalStats(build(), 2)
    expect(Object.keys(pruned.days).sort()).toEqual(['2026-01-06', '2026-01-07'])
  })

  it('清掉不再被引用的歌曲快照', () => {
    const pruned = pruneLocalStats(build(), 2)
    expect(Object.keys(pruned.songs).sort()).toEqual(['6', '7'])
  })

  it('保留全部时不丢数据', () => {
    expect(pruneLocalStats(build(), 365).days).toEqual(build().days)
  })
})

describe('summarizeLocalStats', () => {
  const stats = (() => {
    let input = emptyLocalStats()
    input = addListenedSeconds(input, song(1, '甲'), 100, at(2026, 1, 5))
    input = addListenedSeconds(input, song(2, '乙'), 50, at(2026, 1, 5))
    input = addListenedSeconds(input, song(1, '甲'), 30, at(2026, 1, 6))
    input = addListenedSeconds(input, song(3, '窗口外'), 999, at(2026, 1, 9))
    return input
  })()

  it('区间为闭区间且窗口外不计入', () => {
    const summary = summarizeLocalStats(stats, '2026-01-05', '2026-01-06')
    expect(summary.totalSeconds).toBe(180)
    expect(summary.activeDays).toBe(2)
    expect(summary.songCount).toBe(2)
    expect(summary.topSongs.map((item) => item.song.id)).toEqual([1, 2])
    expect(summary.topSongs[0]?.seconds).toBe(130)
    expect(summary.daily).toEqual([
      { date: '2026-01-05', seconds: 150 },
      { date: '2026-01-06', seconds: 30 },
    ])
  })

  it('TOP 数量受 limit 限制', () => {
    expect(summarizeLocalStats(stats, '2026-01-05', '2026-01-09', 1).topSongs).toHaveLength(1)
  })

  it('空窗口给出全零结果', () => {
    const summary = summarizeLocalStats(emptyLocalStats(), '2026-01-01', '2026-01-31')
    expect(summary.totalSeconds).toBe(0)
    expect(summary.topSongs).toEqual([])
    expect(summary.daily).toEqual([])
  })
})

describe('localStatsWindow', () => {
  const now = at(2026, 1, 10, 20)

  it('today 的起止相同', () => {
    expect(localStatsWindow(now, 'today')).toEqual({ from: '2026-01-10', to: '2026-01-10' })
  })

  it('week 覆盖含今天在内的 7 个日历天', () => {
    expect(localStatsWindow(now, 'week')).toEqual({ from: '2026-01-04', to: '2026-01-10' })
  })

  it('month 与 year 窗口更宽', () => {
    const month = localStatsWindow(now, 'month')
    const year = localStatsWindow(now, 'year')
    expect(month.from < month.to).toBe(true)
    expect(year.from < month.from).toBe(true)
  })

  it('窗口结果能直接喂给汇总函数', () => {
    const { from, to } = localStatsWindow(now, 'week')
    expect(summarizeLocalStats(emptyLocalStats(), from, to).totalSeconds).toBe(0)
  })
})
