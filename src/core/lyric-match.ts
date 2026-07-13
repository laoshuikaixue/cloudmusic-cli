/**
 * 歌词候选匹配与正文/时间轴一致性校验。
 * 参考 SPlayer-Next 的纯匹配器实现，保留在 daemon 可复用的无状态层。
 */
import type { LyricLine, Song } from './types.js'

const MIN_CONTENT_SCORE = 0.82
const MAX_ANCHOR_DIFF = 3
const MAX_P90_DIFF = 2.5
const MAX_TIMELINE_DRIFT = 4
const MIN_TIMELINE_RATIO = 0.985
const MAX_TIMELINE_RATIO = 1.015
const MIN_LINE_SIMILARITY = 0.68
const METADATA_LINE_RE =
  /^(?:作词|作曲|编曲|制作人|混音|母带|录音|词|曲|composer|lyricist|arranger|producer|mixed by)\s*[:：]/i

interface ComparableLine {
  text: string
  startTime: number
  endTime: number
}

interface MatchAnchor {
  referenceStart: number
  candidateStart: number
}

export interface LyricMatchDecision {
  status: 'accepted' | 'rejected' | 'uncertain'
  reason: string
  metrics: Record<string, number | undefined>
}

export interface LyricCandidate<Extra = unknown> {
  name: string
  artist: string
  album?: string
  duration?: number
  extra: Extra
}

const normalizeText = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')

const toComparableLines = (lines: LyricLine[]): ComparableLine[] =>
  lines.flatMap((line) => {
    if (line.isBackground) return []
    const raw = line.text.trim()
    if (!raw || METADATA_LINE_RE.test(raw)) return []
    const text = normalizeText(raw)
    if (text.length < 2) return []
    return [{ text, startTime: line.time, endTime: line.endTime }]
  })

const textSimilarity = (left: string, right: string): number => {
  if (left === right) return 1
  if (!left || !right) return 0
  if (left.length < right.length) return textSimilarity(right, left)
  const previous = new Uint16Array(right.length + 1)
  const current = new Uint16Array(right.length + 1)
  for (let index = 0; index <= right.length; index += 1) previous[index] = index
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
    previous.set(current)
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length)
}

const spanLength = (lines: ComparableLine[], start: number, count: number) =>
  lines[start]!.text.length + (count === 2 ? lines[start + 1]!.text.length : 0)

const joinSpan = (lines: ComparableLine[], start: number, count: number) =>
  count === 1 ? lines[start]!.text : lines[start]!.text + lines[start + 1]!.text

const alignLines = (reference: ComparableLine[], candidate: ComparableLine[]) => {
  const width = candidate.length + 1
  const size = (reference.length + 1) * width
  const scores = new Float64Array(size)
  const previousReference = new Uint8Array(size)
  const previousCandidate = new Uint8Array(size)

  const update = (
    fromReference: number,
    fromCandidate: number,
    referenceCount: number,
    candidateCount: number,
    addedScore: number,
  ) => {
    const nextReference = fromReference + referenceCount
    const nextCandidate = fromCandidate + candidateCount
    const from = fromReference * width + fromCandidate
    const next = nextReference * width + nextCandidate
    const score = scores[from]! + addedScore
    if (score <= scores[next]!) return
    scores[next] = score
    previousReference[next] = referenceCount
    previousCandidate[next] = candidateCount
  }

  for (let i = 0; i <= reference.length; i += 1) {
    for (let j = 0; j <= candidate.length; j += 1) {
      if (i < reference.length) update(i, j, 1, 0, 0)
      if (j < candidate.length) update(i, j, 0, 1, 0)
      for (let referenceCount = 1; referenceCount <= 2; referenceCount += 1) {
        if (i + referenceCount > reference.length) break
        for (let candidateCount = 1; candidateCount <= 2; candidateCount += 1) {
          if (j + candidateCount > candidate.length) break
          const referenceLength = spanLength(reference, i, referenceCount)
          const candidateLength = spanLength(candidate, j, candidateCount)
          if (
            Math.min(referenceLength, candidateLength) /
              Math.max(referenceLength, candidateLength) <
            MIN_LINE_SIMILARITY
          ) {
            continue
          }
          const referenceText = joinSpan(reference, i, referenceCount)
          const candidateText = joinSpan(candidate, j, candidateCount)
          const similarity = textSimilarity(referenceText, candidateText)
          if (similarity < MIN_LINE_SIMILARITY) continue
          update(
            i,
            j,
            referenceCount,
            candidateCount,
            Math.min(referenceText.length, candidateText.length) * similarity,
          )
        }
      }
    }
  }

  const anchors: MatchAnchor[] = []
  let i = reference.length
  let j = candidate.length
  while (i > 0 || j > 0) {
    const index = i * width + j
    const referenceCount = previousReference[index]!
    const candidateCount = previousCandidate[index]!
    if (referenceCount === 0 && candidateCount === 0) break
    const previousI = i - referenceCount
    const previousJ = j - candidateCount
    if (referenceCount > 0 && candidateCount > 0) {
      anchors.push({
        referenceStart: reference[previousI]!.startTime,
        candidateStart: candidate[previousJ]!.startTime,
      })
    }
    i = previousI
    j = previousJ
  }
  anchors.reverse()
  return { score: scores[size - 1]!, anchors }
}

export const evaluateLyricMatch = (
  referenceLines: LyricLine[],
  candidateLines: LyricLine[],
  referenceDuration?: number,
  candidateDuration?: number,
): LyricMatchDecision => {
  const metrics: Record<string, number | undefined> = {}
  if (referenceDuration && candidateDuration) {
    metrics.durationDiffMs = Math.abs(referenceDuration - candidateDuration)
    metrics.durationLimitMs = Math.max(8000, referenceDuration * 0.04)
    if (metrics.durationDiffMs > metrics.durationLimitMs) {
      return { status: 'rejected', reason: 'duration_mismatch', metrics }
    }
  }

  const reference = toComparableLines(referenceLines)
  const candidate = toComparableLines(candidateLines)
  if (reference.length < 3 || candidate.length < 3) {
    return { status: 'uncertain', reason: 'insufficient_lines', metrics }
  }

  const aligned = alignLines(reference, candidate)
  const referenceCharacters = reference.reduce((sum, line) => sum + line.text.length, 0)
  const candidateCharacters = candidate.reduce((sum, line) => sum + line.text.length, 0)
  metrics.contentScore = (2 * aligned.score) / (referenceCharacters + candidateCharacters)
  if (metrics.contentScore < MIN_CONTENT_SCORE) {
    return { status: 'rejected', reason: 'content_mismatch', metrics }
  }

  const anchors = aligned.anchors.filter(
    (anchor) => Number.isFinite(anchor.referenceStart) && Number.isFinite(anchor.candidateStart),
  )
  metrics.anchorCount = anchors.length
  const timelineDuration =
    (referenceDuration || 0) / 1000 || reference.at(-1)?.endTime || reference.at(-1)?.startTime || 0
  const minimumAnchors = timelineDuration > 0 && timelineDuration < 60 ? 3 : 6
  if (anchors.length < minimumAnchors) {
    return { status: 'uncertain', reason: 'insufficient_anchors', metrics }
  }

  const first = anchors[0]!
  const last = anchors.at(-1)!
  const referenceSpan = last.referenceStart - first.referenceStart
  const candidateSpan = last.candidateStart - first.candidateStart
  metrics.timelineCoverage = timelineDuration > 0 ? referenceSpan / timelineDuration : 0
  const minimumCoverage = timelineDuration > 0 && timelineDuration < 60 ? 0.35 : 0.5
  if (metrics.timelineCoverage < minimumCoverage) {
    return { status: 'uncertain', reason: 'insufficient_timeline_coverage', metrics }
  }

  const differences = anchors
    .map((anchor) => Math.abs(anchor.candidateStart - anchor.referenceStart))
    .sort((left, right) => left - right)
  metrics.withinTimeRatio =
    differences.filter((difference) => difference <= MAX_ANCHOR_DIFF).length / differences.length
  metrics.p90DiffMs =
    (differences[Math.max(0, Math.ceil(differences.length * 0.9) - 1)] || 0) * 1000
  const firstOffset = first.candidateStart - first.referenceStart
  const lastOffset = last.candidateStart - last.referenceStart
  metrics.timelineDriftMs = Math.abs(lastOffset - firstOffset) * 1000
  metrics.timelineRatio = referenceSpan > 0 ? candidateSpan / referenceSpan : 0

  if (
    metrics.withinTimeRatio < 0.8 ||
    (metrics.p90DiffMs || 0) > MAX_P90_DIFF * 1000 ||
    (metrics.timelineDriftMs || 0) > MAX_TIMELINE_DRIFT * 1000 ||
    metrics.timelineRatio < MIN_TIMELINE_RATIO ||
    metrics.timelineRatio > MAX_TIMELINE_RATIO
  ) {
    return { status: 'rejected', reason: 'timeline_mismatch', metrics }
  }

  return { status: 'accepted', reason: 'matched', metrics }
}

const normalize = (text?: string | null) =>
  (text || '').toLowerCase().replace(/[、&;，,/|()·・\s\-_ '"`~!?？！.。]+/g, '')

const bothContain = (left: string, right: string) =>
  Boolean(left && right && (left.includes(right) || right.includes(left)))

const splitArtists = (text?: string | null) =>
  (text || '')
    .split(/[、&;，,/|·・]+/g)
    .map(normalize)
    .filter(Boolean)

const versionMarkers: Array<{ key: string; pattern: RegExp }> = [
  { key: 'live', pattern: /\blive\b|现场/i },
  { key: 'remix', pattern: /\bremix\b|混音/i },
  { key: 'instrumental', pattern: /\binstrumental\b|伴奏/i },
  { key: 'acoustic', pattern: /\bacoustic\b|不插电/i },
  { key: 'cover', pattern: /\bcover\b|翻唱/i },
  { key: 'demo', pattern: /\bdemo\b/i },
  { key: 'remaster', pattern: /\bremaster(?:ed)?\b|重制/i },
  { key: 'edit', pattern: /\bedit\b/i },
  { key: 'new', pattern: /新版/i },
  { key: 'old', pattern: /旧版/i },
]

const getVersionMarkers = (text: string) =>
  versionMarkers
    .filter(({ pattern }) => pattern.test(text))
    .map(({ key }) => key)
    .sort()

const stripVersionMarkers = (text: string) => {
  const stripped = versionMarkers
    .reduce((value, { pattern }) => value.replace(pattern, ''), text)
    .trim()
  return stripped || text
}

export const pickBestLyricCandidate = <Extra>(
  candidates: LyricCandidate<Extra>[],
  song: Song,
): LyricCandidate<Extra> | null => {
  const songName = normalize(stripVersionMarkers(song.name))
  const songArtists = song.artists.map((artist) => normalize(artist.name)).filter(Boolean)
  const songAlbum = normalize(song.album.name)
  let best: LyricCandidate<Extra> | null = null
  let bestScore = 0

  for (const candidate of candidates) {
    if (getVersionMarkers(candidate.name).join('|') !== getVersionMarkers(song.name).join('|'))
      continue
    const candidateName = normalize(stripVersionMarkers(candidate.name))
    const nameExact = Boolean(candidateName && candidateName === songName)
    if (!nameExact) {
      if (!bothContain(candidateName, songName)) continue
      const longer = Math.max(candidateName.length, songName.length)
      const shorter = Math.min(candidateName.length, songName.length)
      if (!longer || shorter / longer < 0.34) continue
    }
    if (
      candidate.duration &&
      song.duration &&
      Math.abs(candidate.duration - song.duration) > Math.max(8000, song.duration * 0.04)
    ) {
      continue
    }

    const fullArtist = normalize(candidate.artist)
    const artistParts = splitArtists(candidate.artist)
    const artistExact = songArtists.some(
      (artist) => fullArtist === artist || artistParts.some((part) => part === artist),
    )
    const artistContains = songArtists.some(
      (artist) =>
        artist.length >= 2 &&
        (bothContain(fullArtist, artist) || artistParts.some((part) => bothContain(part, artist))),
    )
    if (songArtists.length && !artistExact && !artistContains) continue

    let score = nameExact ? 10 : 4
    if (artistExact) score += 5
    else if (artistContains) score += 2
    if (songAlbum && normalize(candidate.album) === songAlbum) score += 2
    if (candidate.duration && Math.abs(candidate.duration - song.duration) <= 5000) score += 3
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}
