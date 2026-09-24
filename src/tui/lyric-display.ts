import { LYRIC_DISPLAY_MODES } from '../core/config.js'
import type { LyricDisplayMode, LyricLine, LyricView } from '../core/types.js'

export const LYRIC_MODE_LABELS: Record<LyricDisplayMode, string> = {
  original: '仅原文',
  both: '原文+译文',
  translation: '仅译文',
  romanization: '仅罗马音',
}

export const nextLyricDisplayMode = (mode: LyricDisplayMode): LyricDisplayMode => {
  const index = LYRIC_DISPLAY_MODES.indexOf(mode)
  return LYRIC_DISPLAY_MODES[(index + 1) % LYRIC_DISPLAY_MODES.length] ?? 'both'
}

/** 主区域显示的文字；要求的语言层缺失时回退原文 */
export const lyricMainText = (line: LyricLine | undefined, mode: LyricDisplayMode): string => {
  if (!line) return ''
  if (mode === 'translation') return line.translation?.trim() || line.text
  if (mode === 'romanization') return line.romanization?.trim() || line.text
  return line.text
}

/** 主行下方的附加行，只在「原文+译文」模式下出现，优先译文再看罗马音 */
export const lyricSubText = (line: LyricLine | undefined, mode: LyricDisplayMode): string => {
  if (!line || mode !== 'both') return ''
  return line.translation?.trim() || line.romanization?.trim() || ''
}

/** 逐字高亮依赖原文的逐字时间轴，显示译文/罗马音或关闭 karaoke 时退化为整行 */
export const useWordTiming = (
  line: LyricLine | undefined,
  view: LyricView | undefined,
  text: string,
): boolean => {
  if (!line?.words?.length) return false
  if (view && !view.karaoke) return false
  return text === line.text
}

/** 歌词定位用的位置，偏移不影响播放进度 */
export const lyricPositionOf = (position: number, offsetMs: number) =>
  Math.max(0, position + offsetMs / 1000)

/** 按 step 推移歌词偏移，并收敛到 ±limit */
export const stepLyricOffset = (offsetMs: number, stepMs: number, limit: number) =>
  Math.max(-limit, Math.min(limit, offsetMs + stepMs))
