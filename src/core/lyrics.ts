import { XMLParser } from 'fast-xml-parser'
import { detectBackgroundLine, splitTrailingBackground } from './lyric-bg.js'
import type { LyricFormat, LyricLine, LyricWord } from './types.js'

const timePattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const yrcLinePattern = /^\[(\d+),(\d+)\](.*)$/
// YRC 时间标记只能是 (数字,数字,数字)，其余括号视为歌词文本
const yrcTimingPattern = /\((\d+),(\d+),\d+\)/g
// QRC 时间标记只能是 (数字,数字)，其余括号视为歌词文本
const qrcTimingPattern = /\((\d+),(\d+)\)/g
// CJK 部首补充 / 康熙部首 / 兼容表意文字区间，刻意不含全角字母数字
const kangxiCompatPattern = /[\u2e80-\u2eff\u2f00-\u2fdf\uf900-\ufaff]/g

/** 将康熙部首等兼容字符归一化为常规汉字（如 ⾏ → 巾） */
export const normalizeKangxi = (text: string) =>
  text.replace(kangxiCompatPattern, (char) => char.normalize('NFKC'))

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  preserveOrder: true,
  trimValues: false,
  processEntities: true,
})

type XmlNode = Record<string, any>

const seconds = (milliseconds: number) => milliseconds / 1000

const finalizeLineEnds = (lines: LyricLine[]) => {
  const sorted = lines.sort(
    (a, b) => a.time - b.time || Number(a.isBackground) - Number(b.isBackground),
  )
  for (let index = 0; index < sorted.length; index += 1) {
    const line = sorted[index]!
    line.text = normalizeKangxi(line.text)
    if (line.translation) line.translation = normalizeKangxi(line.translation)
    for (const word of line.words || []) word.text = normalizeKangxi(word.text)
    if (line.endTime > line.time) continue
    const next = sorted.slice(index + 1).find((candidate) => !candidate.isBackground)
    line.endTime = next ? Math.max(line.time, next.time) : line.time + 5
  }
  return sorted
}

export const parseLrc = (input?: string): LyricLine[] => {
  if (!input) return []
  const result: LyricLine[] = []
  for (const rawLine of input.replace(/\r/g, '').split('\n')) {
    const matches = [...rawLine.matchAll(timePattern)]
    if (!matches.length) continue
    const text = rawLine.replace(timePattern, '').trim()
    for (const match of matches) {
      const minute = Number(match[1] || 0)
      const second = Number(match[2] || 0)
      const fractionRaw = match[3] || '0'
      const fraction = Number(fractionRaw.padEnd(3, '0').slice(0, 3)) / 1000
      result.push({ time: minute * 60 + second + fraction, endTime: 0, text })
    }
  }
  return finalizeLineEnds(result)
}

export const parseYrc = (input?: string): LyricLine[] => {
  if (!input) return []
  const result: LyricLine[] = []
  for (const rawLine of input.replace(/\r/g, '').split('\n')) {
    const match = rawLine.match(yrcLinePattern)
    if (!match) continue
    const lineStart = Number(match[1])
    const lineDuration = Number(match[2])
    const content = match[3] || ''
    const words: LyricWord[] = []
    // 逐个时间标记切分，标记之后到下一标记前的内容（含字面括号）保留为歌词文本
    const timings = [...content.matchAll(yrcTimingPattern)]
    for (let index = 0; index < timings.length; index += 1) {
      const wordMatch = timings[index]!
      const startTime = Number(wordMatch[1])
      const duration = Number(wordMatch[2])
      const textStart = wordMatch.index + wordMatch[0].length
      const textEnd = index + 1 < timings.length ? timings[index + 1]!.index : content.length
      const text = content.slice(textStart, textEnd)
      if (!text) continue
      words.push({
        startTime: seconds(startTime),
        endTime: seconds(startTime + duration),
        text,
      })
    }
    // 首个时间标记前的字面文本（如背景行开括号）归入首字
    const leading = timings.length ? content.slice(0, timings[0]!.index) : ''
    if (leading && words.length) words[0]!.text = leading + words[0]!.text
    pushWordTimedLine(result, seconds(lineStart), seconds(lineStart + lineDuration), words)
  }
  return finalizeLineEnds(result)
}

const pushWordTimedLine = (
  result: LyricLine[],
  time: number,
  endTime: number,
  rawWords: LyricWord[],
) => {
  if (!Number.isFinite(time)) return
  const isBackground = detectBackgroundLine(rawWords)
  const words = rawWords.filter((word) => word.text.length > 0)
  const text = words
    .map((word) => word.text)
    .join('')
    .trim()
  if (!text) return
  const line: LyricLine = { time, endTime, text, words }
  if (isBackground) {
    line.isBackground = true
  } else {
    const background = splitTrailingBackground(line)
    if (background) result.push(background)
  }
  result.push(line)
}

const decodeXmlEntities = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const extractQrcContent = (input: string) => {
  if (!input.trimStart().startsWith('<')) return input
  const attribute = input.match(/LyricContent="([\s\S]*?)"\s*\/?>(?:\s*<\/Lyric_.*?>)?/i)
  if (attribute?.[1]) return decodeXmlEntities(attribute[1]).replace(/\\n/g, '\n')
  const cdata = input.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  return cdata?.[1] || input
}

export const parseQrc = (input?: string): LyricLine[] => {
  if (!input) return []
  const result: LyricLine[] = []
  for (const rawLine of extractQrcContent(input).replace(/\r/g, '').split('\n')) {
    const lineMatch = rawLine.trim().match(yrcLinePattern)
    if (!lineMatch) continue
    const lineStart = Number(lineMatch[1])
    const lineDuration = Number(lineMatch[2])
    const content = lineMatch[3] || ''
    const words: LyricWord[] = []
    // 逐个时间标记切分，标记之间的内容（含字面括号）全部保留为歌词文本
    let cursor = 0
    for (const wordMatch of content.matchAll(qrcTimingPattern)) {
      const text = content.slice(cursor, wordMatch.index)
      cursor = wordMatch.index + wordMatch[0].length
      const startTime = Number(wordMatch[1])
      const duration = Number(wordMatch[2])
      if (!text) continue
      words.push({
        startTime: seconds(startTime),
        endTime: seconds(startTime + duration),
        text,
      })
    }
    // 末个时间标记后的字面文本（如背景行闭括号）归入末字
    const trailing = content.slice(cursor)
    if (trailing && words.length) words[words.length - 1]!.text += trailing
    pushWordTimedLine(result, seconds(lineStart), seconds(lineStart + lineDuration), words)
  }
  return finalizeLineEnds(result)
}

const attribute = (node: XmlNode, name: string): string | undefined => {
  const attributes = node[':@'] || {}
  for (const [key, value] of Object.entries(attributes)) {
    if (key === `@${name}` || key.endsWith(`:${name}`)) return String(value)
  }
  return undefined
}

const parseTtmlTime = (value?: string) => {
  if (!value) return 0
  const text = value.trim()
  if (text.endsWith('ms')) return Number(text.slice(0, -2)) / 1000
  if (text.endsWith('s') && !text.includes(':')) return Number(text.slice(0, -1))
  const parts = text.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return 0
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  return parts[0] || 0
}

const nodeText = (
  nodes: XmlNode[],
  excludedRoles = new Set(['x-translation', 'x-roman']),
): string => {
  let text = ''
  for (const node of nodes || []) {
    if (typeof node['#text'] === 'string') text += node['#text']
    for (const [key, children] of Object.entries(node)) {
      if (key === '#text' || key === ':@' || !Array.isArray(children)) continue
      const role = attribute(node, 'role')
      if (!excludedRoles.has(role || '')) text += nodeText(children as XmlNode[], excludedRoles)
    }
  }
  return text
}

const collectElements = (nodes: XmlNode[], name: string, output: XmlNode[] = []) => {
  for (const node of nodes || []) {
    for (const [key, children] of Object.entries(node)) {
      if (key === ':@' || key === '#text' || !Array.isArray(children)) continue
      const localName = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key
      if (localName === name) output.push(node)
      collectElements(children as XmlNode[], name, output)
    }
  }
  return output
}

const parseTtmlWords = (
  nodes: XmlNode[],
  fallbackStart: number,
  fallbackEnd: number,
  isDuet = false,
): {
  words: LyricWord[]
  translation?: string
  romanization?: string
  backgrounds: LyricLine[]
} => {
  const words: LyricWord[] = []
  const backgrounds: LyricLine[] = []
  let translation = ''
  let romanization = ''

  for (const node of nodes || []) {
    if (typeof node['#text'] === 'string' && node['#text']) {
      if (words.length) words[words.length - 1]!.text += node['#text']
      continue
    }
    for (const [key, childrenValue] of Object.entries(node)) {
      if (key === ':@' || key === '#text' || !Array.isArray(childrenValue)) continue
      const children = childrenValue as XmlNode[]
      const localName = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key
      if (localName !== 'span') continue
      const role = attribute(node, 'role')
      const startTime = parseTtmlTime(attribute(node, 'begin')) || fallbackStart
      const endTime = parseTtmlTime(attribute(node, 'end')) || fallbackEnd
      const text = nodeText(children)
      if (role === 'x-translation') {
        translation += text
        continue
      }
      if (role === 'x-roman') {
        romanization += text
        continue
      }
      if (role === 'x-bg') {
        const nested = parseTtmlWords(children, startTime, endTime, isDuet)
        const backgroundText = nested.words.map((word) => word.text).join('') || text
        if (backgroundText.trim()) {
          backgrounds.push({
            time: startTime,
            endTime,
            text: backgroundText.trim(),
            words:
              nested.words.length > 0
                ? nested.words
                : [{ startTime, endTime, text: backgroundText.trim() }],
            translation: nested.translation,
            romanization: nested.romanization,
            isBackground: true,
            isDuet,
          })
        }
        continue
      }
      const nested = parseTtmlWords(children, startTime, endTime, isDuet)
      if (nested.words.length) {
        words.push(...nested.words)
        backgrounds.push(...nested.backgrounds)
        translation += nested.translation || ''
        romanization += nested.romanization || ''
      } else if (text) {
        words.push({ startTime, endTime, text })
      }
    }
  }

  return {
    words,
    backgrounds,
    translation: translation.trim() || undefined,
    romanization: romanization.trim() || undefined,
  }
}

export const parseTtml = (input?: string): LyricLine[] => {
  if (!input?.includes('<tt')) return []
  let document: XmlNode[]
  try {
    document = xmlParser.parse(input) as XmlNode[]
  } catch {
    return []
  }
  const paragraphs = collectElements(document, 'p')
  const result: LyricLine[] = []
  const declaredAgents = collectElements(document, 'agent')
  let mainAgent =
    attribute(declaredAgents.find((agent) => attribute(agent, 'type') === 'person') || {}, 'id') ||
    ''
  for (const paragraph of paragraphs) {
    const childrenEntry = Object.entries(paragraph).find(([key]) => {
      const localName = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key
      return localName === 'p'
    })
    const children = (childrenEntry?.[1] as XmlNode[]) || []
    const time = parseTtmlTime(attribute(paragraph, 'begin'))
    const endTime = parseTtmlTime(attribute(paragraph, 'end'))
    const agent = attribute(paragraph, 'agent') || ''
    if (!mainAgent && agent) mainAgent = agent
    const isDuet = Boolean(mainAgent && agent && agent !== mainAgent)
    const role = attribute(paragraph, 'role')
    const parsed = parseTtmlWords(children, time, endTime, isDuet)
    let words = parsed.words
    if (!words.length) {
      const text = nodeText(children).trim()
      if (text) words = [{ startTime: time, endTime, text }]
    }
    const text = words
      .map((word) => word.text)
      .join('')
      .trim()
    if (text) {
      result.push({
        time,
        endTime,
        text,
        words,
        translation: parsed.translation,
        romanization: parsed.romanization,
        isBackground: role === 'x-bg',
        isDuet,
      })
    }
    result.push(...parsed.backgrounds)
  }
  return finalizeLineEnds(result)
}

const alignText = (
  base: LyricLine[],
  input: string | undefined,
  field: 'translation' | 'romanization',
) => {
  const lrc = parseLrc(input)
  const qrc = lrc.length ? [] : parseQrc(input)
  const additions = lrc.length ? lrc : qrc.length ? qrc : parseYrc(input)
  let additionIndex = 0
  for (const line of base) {
    while (
      additionIndex < additions.length - 1 &&
      additions[additionIndex]!.time < line.time - 0.35
    ) {
      additionIndex += 1
    }
    const candidates = [
      additions[additionIndex - 1],
      additions[additionIndex],
      additions[additionIndex + 1],
    ]
    const matched = candidates
      .filter((item): item is LyricLine => Boolean(item))
      .sort((left, right) => Math.abs(left.time - line.time) - Math.abs(right.time - line.time))[0]
    if (matched?.text && Math.abs(matched.time - line.time) < 0.35) line[field] = matched.text
  }
}

export const attachSupplementalLyrics = (
  lines: LyricLine[],
  translation?: string,
  romanization?: string,
) => {
  alignText(lines, translation, 'translation')
  alignText(lines, romanization, 'romanization')
  return lines
}

export const parseNeteaseLyrics = (raw: any): { lines: LyricLine[]; format: 'yrc' | 'lrc' } => {
  const yrc = parseYrc(raw?.yrc?.lyric)
  const format = yrc.length ? 'yrc' : 'lrc'
  const primary = yrc.length ? yrc : parseLrc(raw?.lrc?.lyric)
  alignText(primary, raw?.ytlrc?.lyric || raw?.tlyric?.lyric, 'translation')
  alignText(primary, raw?.yromalrc?.lyric || raw?.romalrc?.lyric, 'romanization')
  return { lines: primary, format }
}

export const mergeLyrics = (raw: any): LyricLine[] => parseNeteaseLyrics(raw).lines

export const parseLyrics = (input: string, format: LyricFormat): LyricLine[] => {
  if (format === 'ttml') return parseTtml(input)
  if (format === 'qrc') return parseQrc(input)
  if (format === 'yrc') return parseYrc(input)
  return parseLrc(input)
}

export const findLyricIndex = (lines: LyricLine[], position: number) => {
  let index = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.isBackground) continue
    if (line.time > position) break
    index = i
  }
  return index
}

export const getLyricContext = (
  lines: LyricLine[],
  position: number,
  previousCount = 2,
  upcomingCount = 3,
) => {
  const primaryLines = lines.filter((line) => !line.isBackground)
  const currentIndex = findLyricIndex(primaryLines, position)
  const upcomingStart = Math.max(0, currentIndex + 1)
  return {
    currentLine: currentIndex >= 0 ? primaryLines[currentIndex] : undefined,
    previousLines:
      currentIndex > 0
        ? primaryLines.slice(Math.max(0, currentIndex - previousCount), currentIndex)
        : [],
    upcomingLines: primaryLines.slice(upcomingStart, upcomingStart + upcomingCount),
  }
}

export const findActiveBackgroundLyrics = (lines: LyricLine[], position: number) =>
  lines.filter(
    (line) =>
      line.isBackground && line.time <= position && Math.max(line.time, line.endTime) >= position,
  )
