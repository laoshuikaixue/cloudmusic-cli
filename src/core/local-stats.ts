import type { Song } from './types.js'

export interface LocalSongSnapshot {
  id: number
  name: string
  artists: string[]
  album?: string
}

/** 本地听歌统计：按天记录每首歌的实际收听秒数，不依赖服务端报告接口 */
export interface LocalPlayStats {
  /** 'YYYY-MM-DD' -> songId -> 累计秒数 */
  days: Record<string, Record<string, number>>
  songs: Record<string, LocalSongSnapshot>
}

export const emptyLocalStats = (): LocalPlayStats => ({ days: {}, songs: {} })

/** 本地时区的日期键，跨天边界按用户所在时区而不是 UTC */
export const localDateKey = (timestamp: number) => {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now())
  const offset = date.getTimezoneOffset() * 60_000
  const shifted = new Date(date.getTime() - offset)
  return shifted.toISOString().slice(0, 10)
}

const cloneStats = (stats: LocalPlayStats): LocalPlayStats => ({
  days: Object.fromEntries(
    Object.entries(stats.days || {}).map(([day, songs]) => [day, { ...songs }]),
  ),
  songs: { ...(stats.songs || {}) },
})

/** 原地累加一段收听时长，秒数向下取整且忽略非正值 */
export const addListenedSeconds = (
  stats: LocalPlayStats,
  song: Song,
  seconds: number,
  at: number,
): LocalPlayStats => {
  const listened = Math.floor(seconds)
  if (!Number.isFinite(listened) || listened <= 0 || !Number.isFinite(song.id)) return stats
  const next = cloneStats(stats)
  const day = localDateKey(at)
  const bucket = next.days[day] || {}
  bucket[String(song.id)] = (bucket[String(song.id)] || 0) + listened
  next.days[day] = bucket
  next.songs[String(song.id)] = {
    id: song.id,
    name: song.name,
    artists: song.artists.map((artist) => artist.name),
    ...(song.album?.name ? { album: song.album.name } : {}),
  }
  return next
}

/** 只保留最近 keepDays 天，并清掉不再被引用的歌曲快照 */
export const pruneLocalStats = (stats: LocalPlayStats, keepDays = 365): LocalPlayStats => {
  const days = Object.entries(stats.days || {}).sort((left, right) =>
    left[0] < right[0] ? 1 : left[0] > right[0] ? -1 : 0,
  )
  const kept = days.slice(0, Math.max(1, Math.floor(keepDays)))
  const next: LocalPlayStats = { days: {}, songs: {} }
  const referenced = new Set<string>()
  for (const [day, songs] of kept) {
    next.days[day] = { ...songs }
    for (const id of Object.keys(songs)) referenced.add(id)
  }
  for (const id of referenced) {
    const snapshot = stats.songs?.[id]
    if (snapshot) next.songs[id] = snapshot
  }
  return next
}

export interface LocalTopEntry {
  song: LocalSongSnapshot
  seconds: number
}

export interface LocalStatsSummary {
  from: string
  to: string
  totalSeconds: number
  activeDays: number
  songCount: number
  topSongs: LocalTopEntry[]
  daily: { date: string; seconds: number }[]
}

/** 取 [from, to] 闭区间内的汇总；日期键为 YYYY-MM-DD，字典序即时间序 */
export const summarizeLocalStats = (
  stats: LocalPlayStats,
  from: string,
  to: string,
  topLimit = 20,
): LocalStatsSummary => {
  const totals = new Map<string, number>()
  const daily: { date: string; seconds: number }[] = []
  let totalSeconds = 0
  for (const [day, songs] of Object.entries(stats.days || {}).sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  )) {
    if (day < from || day > to) continue
    let daySeconds = 0
    for (const [id, seconds] of Object.entries(songs)) {
      if (!Number.isFinite(seconds) || seconds <= 0) continue
      daySeconds += seconds
      totals.set(id, (totals.get(id) || 0) + seconds)
    }
    if (daySeconds > 0) daily.push({ date: day, seconds: daySeconds })
    totalSeconds += daySeconds
  }
  const topSongs = [...totals.entries()]
    .map(([id, seconds]) => ({
      song: stats.songs?.[id] || { id: Number(id), name: '未知歌曲', artists: [] },
      seconds,
    }))
    .sort(
      (left, right) =>
        right.seconds - left.seconds || left.song.name.localeCompare(right.song.name),
    )
    .slice(0, Math.max(1, topLimit))
  return {
    from,
    to,
    totalSeconds,
    activeDays: daily.length,
    songCount: totals.size,
    topSongs,
    daily,
  }
}

/** 区间起点：按本地日历回退天数，避免夏令时导致的小时漂移 */
export const dayKeyOffset = (base: number, days: number) => localDateKey(base - days * 86_400_000)

export type LocalStatsRange = 'today' | 'week' | 'month' | 'year'

const RANGE_DAYS: Record<LocalStatsRange, number> = {
  today: 1,
  week: 7,
  month: 30,
  year: 365,
}

/** 滚动窗口：从今天往回数 N 个日历天 */
export const localStatsWindow = (now: number, range: LocalStatsRange) => {
  const days = Math.max(1, RANGE_DAYS[range] || RANGE_DAYS.week)
  return { from: dayKeyOffset(now, days - 1), to: localDateKey(now) }
}
