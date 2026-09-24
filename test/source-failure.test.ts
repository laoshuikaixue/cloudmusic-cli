import { describe, expect, it } from 'vitest'
import {
  describeSourceFailure,
  isSourceUnavailable,
  SourceUnavailableError,
} from '../src/core/errors.js'

describe('describeSourceFailure', () => {
  it('试听片段只给试听时归为未开启试听', () => {
    const failure = describeSourceFailure({
      fee: 1,
      tried: [{ level: 'exhigh', code: 200 }],
      requestError: '',
      trialOnly: true,
    })
    expect(failure.reason).toBe('trial_disabled')
    expect(failure.fee).toBe(1)
  })

  it('按接口返回的 fee 归类 VIP 与购买限制', () => {
    expect(
      describeSourceFailure({ fee: 1, tried: [], requestError: '', trialOnly: false }).message,
    ).toContain('VIP')
    expect(
      describeSourceFailure({ fee: 4, tried: [], requestError: '', trialOnly: false }).reason,
    ).toBe('vip_required')
    expect(
      describeSourceFailure({ fee: 8, tried: [], requestError: '', trialOnly: false }).reason,
    ).toBe('vip_required')
  })

  it('各档位都返回非 200 code 时保留真实 code', () => {
    const failure = describeSourceFailure({
      tried: [
        { level: 'lossless', code: -1 },
        { level: 'exhigh', code: -1 },
      ],
      requestError: '',
      trialOnly: false,
    })
    expect(failure.reason).toBe('no_url')
    expect(failure.message).toContain('lossless:-1')
    expect(failure.triedLevels).toHaveLength(2)
  })

  it('请求异常优先于无地址结论', () => {
    const failure = describeSourceFailure({
      tried: [{ level: 'exhigh' }],
      requestError: '网络超时',
      trialOnly: false,
    })
    expect(failure.reason).toBe('request_failed')
    expect(failure.message).toContain('网络超时')
  })
})

describe('SourceUnavailableError', () => {
  it('通过 code 识别，保证跨 IPC 仍然可判定', () => {
    const error = new SourceUnavailableError({ reason: 'no_url', message: '暂无版权' })
    expect(error.code).toBe('SOURCE_UNAVAILABLE')
    expect(error.details).toEqual({ reason: 'no_url', message: '暂无版权' })
    const revived = Object.assign(new Error('暂无版权'), {
      name: 'AppError',
      code: 'SOURCE_UNAVAILABLE',
    })
    expect(isSourceUnavailable(revived)).toBe(false)
  })
})
