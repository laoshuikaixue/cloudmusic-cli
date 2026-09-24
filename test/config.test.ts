import { describe, expect, it } from 'vitest'
import { AppError } from '../src/core/errors.js'
import {
  isQualityLevel,
  pickValidConfigPatch,
  qualityChain,
  QUALITY_LEVELS,
  sanitizeConfigPatch,
} from '../src/core/config.js'

describe('qualityChain', () => {
  it('从设定档位沿阶梯降级', () => {
    expect(qualityChain('hires', true)).toEqual([
      'hires',
      'lossless',
      'exhigh',
      'higher',
      'standard',
    ])
  })

  it('关闭降级时只尝试设定档位', () => {
    expect(qualityChain('hires', false)).toEqual(['hires'])
  })

  it('空间音质先尝试本身，再回到码率阶梯', () => {
    expect(qualityChain('sky', true)).toEqual([
      'sky',
      'jymaster',
      'hires',
      'lossless',
      'exhigh',
      'higher',
      'standard',
    ])
  })

  it('最低档位没有可降级空间', () => {
    expect(qualityChain('standard', true)).toEqual(['standard'])
  })

  it('未知档位返回空链', () => {
    expect(qualityChain('master', true)).toEqual([])
    expect(isQualityLevel('master')).toBe(false)
    expect(isQualityLevel('jymaster')).toBe(true)
  })

  it('阶梯中的档位都在支持的音质集合内', () => {
    for (const level of qualityChain('jymaster', true)) {
      expect(QUALITY_LEVELS).toContain(level)
    }
  })
})

describe('sanitizeConfigPatch', () => {
  it('拒绝未知字段而不是静默写入配置文件', () => {
    expect(() => sanitizeConfigPatch({ volume: 30, evil: true })).toThrow(/evil/)
  })

  it('拒绝未知音质档位', () => {
    let error: unknown
    try {
      sanitizeConfigPatch({ quality: 'best' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('INVALID_ARGUMENT')
  })

  it('音量收敛到 0-100 并取整', () => {
    expect(sanitizeConfigPatch({ volume: 172.6 })).toEqual({ volume: 100 })
    expect(sanitizeConfigPatch({ volume: -5 })).toEqual({ volume: 0 })
  })

  it('只保留嵌套组里出现的字段', () => {
    expect(sanitizeConfigPatch({ lyrics: { enableQrc: false } })).toEqual({
      lyrics: { enableQrc: false },
    })
  })

  it('嵌套组里的未知字段同样被拒绝', () => {
    expect(() => sanitizeConfigPatch({ scrobble: { enabled: true, sneaky: 1 } })).toThrow(/sneaky/)
  })

  it('歌词服务地址必须带占位符', () => {
    expect(() =>
      sanitizeConfigPatch({ lyrics: { amllDbServer: 'https://example.com/x' } }),
    ).toThrow(/%p/)
    expect(
      sanitizeConfigPatch({ lyrics: { amllDbServer: 'https://db.example.com/%p/%s.ttml' } }),
    ).toEqual({ lyrics: { amllDbServer: 'https://db.example.com/%p/%s.ttml' } })
  })

  it('ClassLink 端口范围受限', () => {
    expect(() => sanitizeConfigPatch({ classLink: { port: 80 } })).toThrow(/1024/)
    expect(sanitizeConfigPatch({ classLink: { port: 38974 } })).toEqual({
      classLink: { port: 38974 },
    })
  })

  it('拒绝播放模式以外的取值和非布尔开关', () => {
    expect(() => sanitizeConfigPatch({ mode: 'random' })).toThrow(/mode/)
    expect(() => sanitizeConfigPatch({ skipOnError: 'yes' })).toThrow(/skipOnError/)
    expect(() => sanitizeConfigPatch({ qualityFallback: 1 })).toThrow(/qualityFallback/)
  })

  it('空补丁与非法类型视为无效，避免误以为已保存', () => {
    expect(() => sanitizeConfigPatch({})).toThrow(/没有可应用的字段/)
    expect(() => sanitizeConfigPatch({ volume: null })).toThrow(/volume 必须是数字/)
    expect(() => sanitizeConfigPatch({ volume: true })).toThrow(/volume 必须是数字/)
    expect(() => sanitizeConfigPatch({ classLink: { port: '' } })).toThrow(/port 必须是数字/)
  })

  it('接受数字字符串形式的音量与端口', () => {
    expect(sanitizeConfigPatch({ volume: '45' })).toEqual({ volume: 45 })
  })

  it('接受新增的两个开关', () => {
    expect(sanitizeConfigPatch({ qualityFallback: false, skipOnError: true })).toEqual({
      qualityFallback: false,
      skipOnError: true,
    })
  })
})

describe('pickValidConfigPatch', () => {
  it('读取被手工改坏的配置文件时丢弃非法字段', () => {
    const patch = pickValidConfigPatch({
      quality: 'jymaster',
      volume: 'loud',
      mode: 'shuffle',
      unknownGroup: { a: 1 },
    })
    expect(patch).toEqual({ quality: 'jymaster', mode: 'shuffle' })
  })

  it('非对象输入返回空补丁', () => {
    expect(pickValidConfigPatch(null)).toEqual({})
    expect(pickValidConfigPatch(['quality'])).toEqual({})
  })
})

describe('播放音效配置', () => {
  it('只校验补丁里出现的字段', () => {
    expect(sanitizeConfigPatch({ player: { speed: 1.25 } })).toEqual({ player: { speed: 1.25 } })
    expect(sanitizeConfigPatch({ player: { fadeMs: 250 } })).toEqual({ player: { fadeMs: 250 } })
  })

  it('倍速收敛到两位小数并拒绝越界', () => {
    expect(sanitizeConfigPatch({ player: { speed: 1.005 } })).toEqual({ player: { speed: 1 } })
    expect(() => sanitizeConfigPatch({ player: { speed: 0.25 } })).toThrow(/player.speed/)
    expect(() => sanitizeConfigPatch({ player: { speed: 4 } })).toThrow(/player.speed/)
    expect(() => sanitizeConfigPatch({ player: { speed: 0 } })).toThrow(/player.speed/)
  })

  it('响度归一只接受 off/track/album', () => {
    expect(sanitizeConfigPatch({ player: { replayGain: 'album' } })).toEqual({
      player: { replayGain: 'album' },
    })
    expect(() => sanitizeConfigPatch({ player: { replayGain: 'loudness' } })).toThrow(
      /player.replayGain/,
    )
  })

  it('前置增益与淡变时长有上下限', () => {
    expect(sanitizeConfigPatch({ player: { replayGainPreamp: -4.56 } })).toEqual({
      player: { replayGainPreamp: -4.6 },
    })
    expect(() => sanitizeConfigPatch({ player: { replayGainPreamp: 20 } })).toThrow(
      /replayGainPreamp/,
    )
    expect(() => sanitizeConfigPatch({ player: { fadeMs: -1 } })).toThrow(/fadeMs/)
    expect(() => sanitizeConfigPatch({ player: { fadeMs: 99_000 } })).toThrow(/fadeMs/)
  })

  it('拒绝 player 组里的未知字段', () => {
    expect(() => sanitizeConfigPatch({ player: { tempo: 2 } })).toThrow(/tempo/)
  })
})
