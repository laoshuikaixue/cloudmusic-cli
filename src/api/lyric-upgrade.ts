import { getQqLyrics, searchQqSongs, type QqSongCandidate } from './qqmusic.js'
import { evaluateLyricMatch, pickBestLyricCandidate } from '../core/lyric-match.js'
import { attachSupplementalLyrics, parseQrc, parseTtml } from '../core/lyrics.js'
import type { AppConfig, LyricResult, Song } from '../core/types.js'

const ttmlCache = new Map<string, Promise<string | null>>()

const fetchTtmlOnce = async (config: AppConfig, platform: 'netease' | 'qqmusic', id: string) => {
  const template = config.lyrics.amllDbServer
  if (!template.includes('%p') || !template.includes('%s')) return null
  const path = platform === 'netease' ? 'ncm-lyrics' : 'qq-lyrics'
  const url = template.replace('%p', path).replace('%s', encodeURIComponent(id))
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const content = await response.text()
    return content.includes('<tt') ? content : null
  } catch {
    return null
  }
}

const fetchTtml = async (config: AppConfig, platform: 'netease' | 'qqmusic', ids: string[]) => {
  for (const id of ids) {
    if (!id) continue
    const key = `${platform}:${id}:${config.lyrics.amllDbServer}`
    let promise = ttmlCache.get(key)
    if (!promise) {
      promise = fetchTtmlOnce(config, platform, id)
      ttmlCache.set(key, promise)
    }
    const result = await promise
    if (result) return result
  }
  return null
}

const acceptedResult = (
  base: LyricResult,
  lines: LyricResult['lines'],
  format: 'ttml' | 'qrc',
  source: 'amll' | 'qqmusic',
  match: ReturnType<typeof evaluateLyricMatch>,
): LyricResult => ({
  lines,
  format,
  source,
  upgraded: true,
  raw: base.raw,
  match,
})

const validate = (
  song: Song,
  base: LyricResult,
  lines: LyricResult['lines'],
  candidateDuration = song.duration,
) => evaluateLyricMatch(base.lines, lines, song.duration, candidateDuration)

const directTtmlUpgrade = async (song: Song, base: LyricResult, config: AppConfig) => {
  if (!config.lyrics.enableTtml || base.format === 'ttml') return null
  const content = await fetchTtml(config, 'netease', [String(song.id)])
  if (!content) return null
  const lines = parseTtml(content)
  if (!lines.length) return null
  if (base.lines.length < 3) {
    return acceptedResult(base, lines, 'ttml', 'amll', {
      status: 'accepted',
      reason: 'same_platform_id',
      metrics: {},
    })
  }
  const match = validate(song, base, lines)
  return match.status === 'accepted' ? acceptedResult(base, lines, 'ttml', 'amll', match) : null
}

const queryCandidates = async (song: Song) => {
  const artists = song.artists.map((artist) => artist.name).join(' ')
  const queries = [
    `${song.name} ${artists}`.trim(),
    `${song.name} ${song.album.name}`.trim(),
  ].filter(Boolean)
  for (const query of [...new Set(queries)]) {
    try {
      const candidates = await searchQqSongs(query)
      if (pickBestLyricCandidate(candidates.map(toCandidate), song)) return candidates
    } catch {
      // 换下一组关键词。
    }
  }
  return []
}

const toCandidate = (candidate: QqSongCandidate) => ({
  name: candidate.name,
  artist: candidate.artist,
  album: candidate.album,
  duration: candidate.duration,
  extra: candidate,
})

const qqUpgrade = async (song: Song, base: LyricResult, config: AppConfig) => {
  if (!base.lines.length) return null
  if (base.format !== 'lrc' && !config.lyrics.enableTtml) return null
  const candidates = await queryCandidates(song)
  const rejected = new Set<string>()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = pickBestLyricCandidate(
      candidates.filter((item) => !rejected.has(item.id)).map(toCandidate),
      song,
    )?.extra
    if (!candidate) return null
    rejected.add(candidate.id)

    const [ttml, qqLyrics] = await Promise.all([
      config.lyrics.enableTtml
        ? fetchTtml(config, 'qqmusic', [candidate.mid, candidate.id])
        : Promise.resolve(null),
      base.format === 'lrc' && config.lyrics.enableQrc
        ? getQqLyrics(candidate).catch(() => ({}))
        : Promise.resolve({}),
    ])

    if (ttml) {
      const lines = parseTtml(ttml)
      const match = validate(song, base, lines, candidate.duration)
      if (lines.length && match.status === 'accepted') {
        return acceptedResult(base, lines, 'ttml', 'amll', match)
      }
    }

    if ('qrc' in qqLyrics && qqLyrics.qrc) {
      const lines = attachSupplementalLyrics(
        parseQrc(qqLyrics.qrc),
        qqLyrics.translation,
        qqLyrics.romanization,
      )
      const match = validate(song, base, lines, candidate.duration)
      if (lines.length && match.status === 'accepted') {
        return acceptedResult(base, lines, 'qrc', 'qqmusic', match)
      }
    }
  }
  return null
}

export const upgradeLyrics = async (song: Song, base: LyricResult, config: AppConfig) => {
  if (!config.lyrics.upgrade) return base
  const direct = await directTtmlUpgrade(song, base, config)
  if (direct) return direct
  return (await qqUpgrade(song, base, config)) || base
}
