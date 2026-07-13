export type LyricGraphemePhase = 'completed' | 'active' | 'upcoming'

export interface TimedLyricGrapheme {
  text: string
  startTime: number
  endTime: number
  phase: LyricGraphemePhase
  brightness: number
}

export interface WaitingCircle {
  glyph: '●' | '•' | '·' | ' '
  intensity: number
  opacity: number
}

interface TimedLyricWord {
  text: string
  startTime: number
  endTime: number
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const splitGraphemes = (text: string) =>
  [...graphemeSegmenter.segment(text)].map((item) => item.segment)

const clamp = (value: number) => Math.max(0, Math.min(1, value))

export const easeInOutSine = (value: number) => {
  const progress = clamp(value)
  if (progress === 0 || progress === 1) return progress
  return -(Math.cos(Math.PI * progress) - 1) / 2
}

const hexChannel = (value: string, offset: number) =>
  Number.parseInt(value.slice(offset, offset + 2), 16)

export const mixHexColors = (from: string, to: string, progress: number) => {
  const amount = clamp(progress)
  const start = from.replace('#', '')
  const end = to.replace('#', '')
  const channel = (offset: number) =>
    Math.round(
      hexChannel(start, offset) + (hexChannel(end, offset) - hexChannel(start, offset)) * amount,
    )
      .toString(16)
      .padStart(2, '0')
  return `#${channel(0)}${channel(2)}${channel(4)}`
}

/**
 * 首句开始前保持三个灰色实心圆，临近时间点时从左到右依次变亮，
 * 最后一起淡出，在第一句出现时完全隐藏。
 * 动画只由播放位置驱动，不使用墙钟循环，因此暂停和跳转后状态仍然准确。
 */
export const getWaitingCircles = (
  position: number,
  firstLineTime: number,
  fadeDuration = 2.4,
): WaitingCircle[] => {
  const duration = Math.max(0.2, Math.min(fadeDuration, firstLineTime))
  const fadeStart = Math.max(0, firstLineTime - duration)
  const progress = clamp((position - fadeStart) / duration)
  const brightenEnd = 0.8
  const brightenProgress = clamp(progress / brightenEnd)
  const fadeProgress = clamp((progress - brightenEnd) / (1 - brightenEnd))
  const opacity = 1 - easeInOutSine(fadeProgress)

  if (position >= firstLineTime) {
    return [0, 1, 2].map(() => ({ glyph: ' ' as const, intensity: 1, opacity: 0 }))
  }

  return [0, 1, 2].map((index) => {
    const segmentStart = index / 3
    const localProgress = clamp((brightenProgress - segmentStart) * 3)
    return {
      glyph: '●' as const,
      intensity: easeInOutSine(localProgress),
      opacity,
    }
  })
}

/**
 * 只为明显拖长的末词生成呼吸辉光强度。持续时间来自歌词时间轴，
 * 不会把普通句尾或未唱字符误判为长音效果。
 */
export const getSustainGlowIntensity = (
  words: readonly TimedLyricWord[],
  wordIndex: number,
  lineEndTime: number,
  position: number,
) => {
  let lastVisibleIndex = -1
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (words[index]?.text.trim().length) {
      lastVisibleIndex = index
      break
    }
  }
  if (lastVisibleIndex < 0 || wordIndex !== lastVisibleIndex) return 0

  const word = words[wordIndex]
  if (!word) return 0

  const previousDurations = words
    .slice(0, lastVisibleIndex)
    .filter((item) => item.text.trim().length > 0)
    .map((item) => Math.max(0.05, item.endTime - item.startTime))
  const averageDuration = previousDurations.length
    ? previousDurations.reduce((sum, value) => sum + value, 0) / previousDurations.length
    : 0.45
  const sustainEnd = Math.max(word.endTime, lineEndTime)
  const sustainDuration = sustainEnd - word.startTime

  if (sustainDuration < Math.max(0.9, averageDuration * 1.6)) return 0
  if (position < word.startTime || position > sustainEnd) return 0

  const fadeIn = easeInOutSine(Math.min(1, (position - word.startTime) / 0.3))
  const fadeOut = easeInOutSine(Math.min(1, (sustainEnd - position) / 0.3))
  const breathing = 0.78 + Math.sin(position * Math.PI * 2 * 1.2) * 0.22
  return clamp(fadeIn * fadeOut * breathing)
}

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
          : easeInOutSine(
              (position - characterStart) / Math.max(0.001, characterEnd - characterStart),
            )

    return {
      text: grapheme,
      startTime: characterStart,
      endTime: characterEnd,
      phase,
      brightness,
    }
  })
}
