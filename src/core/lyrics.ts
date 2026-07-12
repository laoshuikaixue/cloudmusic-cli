import type { LyricLine } from './types.js'

const timePattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

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
      result.push({ time: minute * 60 + second + fraction, text })
    }
  }
  return result.sort((a, b) => a.time - b.time)
}

const alignText = (
  base: LyricLine[],
  input: string | undefined,
  field: 'translation' | 'romanization',
) => {
  const additions = parseLrc(input)
  for (const line of base) {
    const matched = additions.find((item) => Math.abs(item.time - line.time) < 0.35)
    if (matched?.text) line[field] = matched.text
  }
}

export const mergeLyrics = (raw: any): LyricLine[] => {
  const primary = parseLrc(raw?.yrc?.lyric || raw?.lrc?.lyric)
  alignText(primary, raw?.tlyric?.lyric, 'translation')
  alignText(primary, raw?.romalrc?.lyric, 'romanization')
  return primary
}

export const findLyricIndex = (lines: LyricLine[], position: number) => {
  let index = -1
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i]?.time ?? Infinity) > position) break
    index = i
  }
  return index
}
