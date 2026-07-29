/**
 * 括号背景人声启发式检测。
 */
import type { LyricLine, LyricWord } from './types.js'

/** 行首括号（全 / 半角），允许前导空格 */
const openParenPattern = /^\s*[（(]/

/** 行尾括号（全 / 半角），允许尾随空格 */
const closeParenPattern = /[）)]\s*$/

const hanPattern = /\p{Script=Han}/u

/** 日文假名（含长音符号） */
const kanaOnlyPattern = /^[\p{Script=Hiragana}\p{Script=Katakana}\u30fc\s]+$/u

const joinWords = (words: LyricWord[]) => words.map((word) => word.text).join('')

const stripParens = (text: string) =>
  text
    .replace(/^[\s（(]+/, '')
    .replace(/[）)\s]+$/, '')
    .trim()

/** 日文汉字后的假名注音（如「言(こと)」）不应视为背景人声 */
const isJapaneseRubyTail = (words: LyricWord[], openIndex: number) => {
  const before = joinWords(words.slice(0, openIndex)).trim()
  const previousChar = [...before].at(-1) || ''
  if (!hanPattern.test(previousChar)) return false
  const rubyText = stripParens(joinWords(words.slice(openIndex)))
  return Boolean(rubyText) && kanaOnlyPattern.test(rubyText)
}

/**
 * 检测整行是否被括号包裹的背景人声，命中时原地剥掉首尾括号。
 * @returns 是否为背景人声行
 */
export const detectBackgroundLine = (words: LyricWord[]) => {
  if (!words.length) return false
  const first = words[0]!
  const last = words[words.length - 1]!
  if (!openParenPattern.test(first.text) || !closeParenPattern.test(last.text)) return false
  first.text = first.text.replace(openParenPattern, '')
  last.text = last.text.replace(closeParenPattern, '')
  return true
}

/**
 * 把「主歌词(和声)」这类行尾括号段拆成独立背景行。
 * 仅在整行非括号包裹、行尾以括号收尾、能向前找到配对的开括号
 * 且开括号前仍有主歌词时才拆分；命中时原地裁掉主行尾段并收紧 endTime。
 * @returns 拆出的背景行；未命中返回 null
 */
export const splitTrailingBackground = (line: LyricLine): LyricLine | null => {
  const words = line.words
  if (!words || words.length < 2) return null
  // 整行包裹交给 detectBackgroundLine，这里只处理行内尾随段。
  if (openParenPattern.test(words[0]!.text)) return null
  if (!closeParenPattern.test(words[words.length - 1]!.text)) return null
  let openIndex = -1
  for (let index = words.length - 1; index >= 1; index -= 1) {
    if (openParenPattern.test(words[index]!.text)) {
      openIndex = index
      break
    }
  }
  if (openIndex < 1) return null
  if (isJapaneseRubyTail(words, openIndex)) return null
  // 克隆尾随段并剥掉首尾括号，丢弃因独立括号字而变空的字。
  const backgroundWords = words.slice(openIndex).map((word) => ({ ...word }))
  backgroundWords[0]!.text = backgroundWords[0]!.text.replace(openParenPattern, '')
  backgroundWords[backgroundWords.length - 1]!.text = backgroundWords[
    backgroundWords.length - 1
  ]!.text.replace(closeParenPattern, '')
  const cleaned = backgroundWords.filter((word) => word.text.trim().length > 0)
  if (!cleaned.length) return null
  line.words = words.slice(0, openIndex)
  line.endTime = line.words[line.words.length - 1]!.endTime
  line.text = joinWords(line.words).trim()
  return {
    time: cleaned[0]!.startTime,
    endTime: cleaned[cleaned.length - 1]!.endTime,
    text: joinWords(cleaned).trim(),
    words: cleaned,
    isBackground: true,
  }
}
