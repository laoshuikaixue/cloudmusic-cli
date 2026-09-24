import { AppError } from './errors.js'
import type { AppConfig, ConfigPatch, PlaybackMode, ScrobbleMode } from './types.js'

/** `/song/url/v1` 支持的音质档位 */
export const QUALITY_LEVELS = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'dolby',
  'jymaster',
] as const

export type QualityLevel = (typeof QUALITY_LEVELS)[number]

/**
 * 自动降级阶梯（由高到低）。空间音质依赖设备支持且返回码率不固定，
 * 因此不作为降级目标，只在用户显式选择时优先尝试一次。
 */
export const QUALITY_FALLBACK_LADDER = [
  'jymaster',
  'hires',
  'lossless',
  'exhigh',
  'higher',
  'standard',
] as const satisfies readonly QualityLevel[]

export const isQualityLevel = (value: unknown): value is QualityLevel =>
  typeof value === 'string' && (QUALITY_LEVELS as readonly string[]).includes(value)

/** 依次尝试的音质档位；关闭降级时只返回用户设定档位 */
export const qualityChain = (preferred: unknown, allowFallback: boolean): QualityLevel[] => {
  if (!isQualityLevel(preferred)) return []
  if (!allowFallback) return [preferred]
  const index = (QUALITY_FALLBACK_LADDER as readonly string[]).indexOf(preferred)
  return index >= 0
    ? [...QUALITY_FALLBACK_LADDER.slice(index)]
    : [preferred, ...QUALITY_FALLBACK_LADDER]
}

export const PLAYBACK_MODES = [
  'sequence',
  'repeat-one',
  'shuffle',
] as const satisfies readonly PlaybackMode[]
export const SCROBBLE_MODES = ['ncbl', 'legacy'] as const satisfies readonly ScrobbleMode[]

/** 解灰音源名由依赖包提供，只做格式校验，不内置音源白名单 */
const UNBLOCK_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i

const invalid = (message: string) => new AppError('INVALID_ARGUMENT', message)

const booleanOf = (value: unknown, name: string) => {
  if (typeof value !== 'boolean') throw invalid(`${name} 必须是布尔值`)
  return value
}

const finiteNumberOf = (value: unknown, name: string) => {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(number)) throw invalid(`${name} 必须是数字`)
  return number
}

const stringOf = (value: unknown, name: string, maxLength = 500) => {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${name} 不能为空`)
  const text = value.trim()
  if ([...text].length > maxLength) throw invalid(`${name} 长度不能超过 ${maxLength}`)
  return text
}

const patternOf = (value: unknown, name: string, pattern: RegExp, hint: string) => {
  const text = stringOf(value, name, 100)
  if (!pattern.test(text)) throw invalid(`${name} ${hint}`)
  return text
}

const enumOf = <T extends readonly string[]>(value: unknown, name: string, allowed: T) => {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${name} 只能是 ${allowed.join(' / ')} 之一`)
  }
  return value as T[number]
}

const subsetOf = <T extends object>(value: unknown, name: string, check: (input: T) => T) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${name} 必须是对象`)
  }
  return check(value as T)
}

const knownKeys = (input: object, allowed: readonly string[], name: string) => {
  const unknown = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .filter((key) => !allowed.includes(key))
  if (unknown.length) throw invalid(`${name} 不支持的字段：${unknown.join('、')}`)
}

const checkBinaries = (input: Partial<AppConfig['binaries']>) => {
  knownKeys(input, ['mpv', 'ffmpeg'], 'binaries')
  return {
    ...(input.mpv === undefined ? {} : { mpv: stringOf(input.mpv, 'binaries.mpv', 1000) }),
    ...(input.ffmpeg === undefined
      ? {}
      : { ffmpeg: stringOf(input.ffmpeg, 'binaries.ffmpeg', 1000) }),
  }
}

const checkUnblock = (input: Partial<AppConfig['unblock']>) => {
  knownKeys(input, ['enabled', 'source'], 'unblock')
  return {
    ...(input.enabled === undefined
      ? {}
      : { enabled: booleanOf(input.enabled, 'unblock.enabled') }),
    ...(input.source === undefined
      ? {}
      : {
          source:
            input.source === 'auto'
              ? 'auto'
              : patternOf(
                  input.source,
                  'unblock.source',
                  UNBLOCK_SOURCE_PATTERN,
                  '不是合法的音源名',
                ),
        }),
  }
}

const checkScrobble = (input: Partial<AppConfig['scrobble']>) => {
  knownKeys(input, ['enabled', 'mode', 'configured'], 'scrobble')
  return {
    ...(input.enabled === undefined
      ? {}
      : { enabled: booleanOf(input.enabled, 'scrobble.enabled') }),
    ...(input.mode === undefined
      ? {}
      : { mode: enumOf(input.mode, 'scrobble.mode', SCROBBLE_MODES) }),
    ...(input.configured === undefined
      ? {}
      : { configured: booleanOf(input.configured, 'scrobble.configured') }),
  }
}

export const LYRIC_DISPLAY_MODES = ['original', 'both', 'translation', 'romanization'] as const
/** 偏移超过 ±60 秒基本是误操作 */
export const MAX_LYRIC_OFFSET_MS = 60_000

const checkLyrics = (input: Partial<AppConfig['lyrics']>) => {
  knownKeys(
    input,
    [
      'upgrade',
      'enableTtml',
      'enableQrc',
      'amllDbServer',
      'display',
      'karaoke',
      'background',
      'offsetMs',
    ],
    'lyrics',
  )
  const offsetMs =
    input.offsetMs === undefined ? undefined : finiteNumberOf(input.offsetMs, 'lyrics.offsetMs')
  if (offsetMs !== undefined && Math.abs(offsetMs) > MAX_LYRIC_OFFSET_MS) {
    throw invalid(`lyrics.offsetMs 必须在 ±${MAX_LYRIC_OFFSET_MS} 毫秒之间`)
  }
  return {
    ...(input.upgrade === undefined ? {} : { upgrade: booleanOf(input.upgrade, 'lyrics.upgrade') }),
    ...(input.enableTtml === undefined
      ? {}
      : { enableTtml: booleanOf(input.enableTtml, 'lyrics.enableTtml') }),
    ...(input.enableQrc === undefined
      ? {}
      : { enableQrc: booleanOf(input.enableQrc, 'lyrics.enableQrc') }),
    ...(input.display === undefined
      ? {}
      : { display: enumOf(input.display, 'lyrics.display', LYRIC_DISPLAY_MODES) }),
    ...(input.karaoke === undefined ? {} : { karaoke: booleanOf(input.karaoke, 'lyrics.karaoke') }),
    ...(input.background === undefined
      ? {}
      : { background: booleanOf(input.background, 'lyrics.background') }),
    ...(offsetMs === undefined ? {} : { offsetMs: Math.round(offsetMs) }),
    ...(input.amllDbServer === undefined
      ? {}
      : {
          amllDbServer: patternOf(
            input.amllDbServer,
            'lyrics.amllDbServer',
            /^https?:\/\/\S*%p\S*%s\S*/i,
            '必须是包含 %p 与 %s 占位符的 http(s) 地址',
          ),
        }),
  }
}

const checkSmtc = (input: Partial<AppConfig['smtc']>) => {
  knownKeys(input, ['enabled'], 'smtc')
  return {
    ...(input.enabled === undefined ? {} : { enabled: booleanOf(input.enabled, 'smtc.enabled') }),
  }
}

const checkClassLink = (input: Partial<AppConfig['classLink']>) => {
  knownKeys(input, ['enabled', 'port'], 'classLink')
  const port = input.port === undefined ? undefined : finiteNumberOf(input.port, 'classLink.port')
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw invalid('classLink.port 必须是 1024 到 65535 之间的整数')
  }
  return {
    ...(input.enabled === undefined
      ? {}
      : { enabled: booleanOf(input.enabled, 'classLink.enabled') }),
    ...(port === undefined ? {} : { port }),
  }
}

/**
 * 校验配置补丁：只接受已知字段，逐项收敛类型与取值范围。
 * 返回值只包含通过校验的字段，避免越权字段被写进配置文件。
 */
export const sanitizeConfigPatch = (patch: unknown): ConfigPatch => {
  if (patch === undefined || patch === null) return {}
  if (typeof patch !== 'object' || Array.isArray(patch)) throw invalid('配置补丁必须是对象')
  const input = patch as Record<string, unknown>
  knownKeys(
    input,
    [
      'quality',
      'qualityFallback',
      'skipOnError',
      'volume',
      'mode',
      'allowTrial',
      'unblock',
      'binaries',
      'scrobble',
      'smtc',
      'classLink',
      'lyrics',
    ],
    '配置',
  )

  const result: ConfigPatch = {
    ...(input.quality === undefined
      ? {}
      : { quality: enumOf(input.quality, 'quality', QUALITY_LEVELS) }),
    ...(input.qualityFallback === undefined
      ? {}
      : { qualityFallback: booleanOf(input.qualityFallback, 'qualityFallback') }),
    ...(input.skipOnError === undefined
      ? {}
      : { skipOnError: booleanOf(input.skipOnError, 'skipOnError') }),
    ...(input.volume === undefined
      ? {}
      : {
          volume: Math.round(Math.min(100, Math.max(0, finiteNumberOf(input.volume, 'volume')))),
        }),
    ...(input.mode === undefined ? {} : { mode: enumOf(input.mode, 'mode', PLAYBACK_MODES) }),
    ...(input.allowTrial === undefined
      ? {}
      : { allowTrial: booleanOf(input.allowTrial, 'allowTrial') }),
    ...(input.unblock === undefined
      ? {}
      : { unblock: subsetOf(input.unblock, 'unblock', checkUnblock) }),
    ...(input.binaries === undefined
      ? {}
      : { binaries: subsetOf(input.binaries, 'binaries', checkBinaries) }),
    ...(input.scrobble === undefined
      ? {}
      : { scrobble: subsetOf(input.scrobble, 'scrobble', checkScrobble) }),
    ...(input.smtc === undefined ? {} : { smtc: subsetOf(input.smtc, 'smtc', checkSmtc) }),
    ...(input.classLink === undefined
      ? {}
      : { classLink: subsetOf(input.classLink, 'classLink', checkClassLink) }),
    ...(input.lyrics === undefined
      ? {}
      : { lyrics: subsetOf(input.lyrics, 'lyrics', checkLyrics) }),
  }
  if (!Object.keys(result).length) throw invalid('配置补丁没有可应用的字段')
  return result
}

/** 逐项宽容校验：读取磁盘上可能被手工编辑过的配置时，丢弃非法字段而不是让 daemon 起不来 */
export const pickValidConfigPatch = (patch: unknown): ConfigPatch => {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return {}
  const accepted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    try {
      Object.assign(accepted, sanitizeConfigPatch({ [key]: value }))
    } catch {
      // 非法字段回落到默认值。
    }
  }
  return accepted as ConfigPatch
}
