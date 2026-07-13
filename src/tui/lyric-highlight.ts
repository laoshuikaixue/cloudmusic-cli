export type LyricGraphemePhase = 'completed' | 'active' | 'upcoming'

export interface TimedLyricGrapheme {
  text: string
  startTime: number
  endTime: number
  phase: LyricGraphemePhase
  brightness: number
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const splitGraphemes = (text: string) =>
  [...graphemeSegmenter.segment(text)].map((item) => item.segment)

const clamp = (value: number) => Math.max(0, Math.min(1, value))

/**
 * 部分歌词源只提供词级时间。这里在该时间片内部按可见 Unicode 字符均分，
 * 生成用于终端明暗渐变的视觉时间；不会修改 daemon 保存的原始歌词时间。
 */
export const interpolateWordGraphemes = (
  text: string,
  startTime: number,
  endTime: number,
  position: number,
): TimedLyricGrapheme[] => {
  const graphemes = splitGraphemes(text)
  const visibleCount = Math.max(1, graphemes.filter((item) => !/^\s+$/u.test(item)).length)
  const duration = Math.max(0.001, endTime - startTime)
  let visibleIndex = 0
  let previousBoundary = startTime

  return graphemes.map((grapheme) => {
    const whitespace = /^\s+$/u.test(grapheme)
    const characterStart = whitespace
      ? previousBoundary
      : startTime + (duration * visibleIndex) / visibleCount
    if (!whitespace) visibleIndex += 1
    const characterEnd = whitespace
      ? characterStart
      : startTime + (duration * visibleIndex) / visibleCount
    previousBoundary = characterEnd

    const phase: LyricGraphemePhase =
      position >= characterEnd ? 'completed' : position < characterStart ? 'upcoming' : 'active'
    const brightness =
      phase === 'completed'
        ? 1
        : phase === 'upcoming'
          ? 0
          : clamp((position - characterStart) / Math.max(0.001, characterEnd - characterStart))

    return {
      text: grapheme,
      startTime: characterStart,
      endTime: characterEnd,
      phase,
      brightness,
    }
  })
}
