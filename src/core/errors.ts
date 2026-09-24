import type { SourceFailure } from './types.js'

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/** 网易云未返回可播放音源，details 保存接口真实返回的判定材料 */
export class SourceUnavailableError extends AppError {
  constructor(readonly failure: SourceFailure) {
    super('SOURCE_UNAVAILABLE', failure.message, failure)
    this.name = 'SourceUnavailableError'
  }
}

export const isSourceUnavailable = (error: unknown): error is SourceUnavailableError =>
  error instanceof SourceUnavailableError ||
  (error instanceof AppError && error.code === 'SOURCE_UNAVAILABLE')

const feeMessages: Record<number, string> = {
  1: '该歌曲为 VIP 专享，需要会员或购买后播放',
  4: '该歌曲需要购买后播放',
  8: '该歌曲的高音质需要会员，可降低音质或开通会员',
}

/** 只用接口返回的 fee、各档 code 和错误文本归纳失败原因，不做任何推断 */
export const describeSourceFailure = (input: {
  fee?: number
  tried: { level: string; code?: number }[]
  requestError: string
  trialOnly: boolean
}): SourceFailure => {
  const base = {
    fee: input.fee,
    triedLevels: input.tried.length ? input.tried : undefined,
  }
  if (input.trialOnly) {
    return {
      reason: 'trial_disabled',
      message: '歌曲仅提供试听片段，当前未开启试听',
      ...base,
    }
  }
  const feeMessage = input.fee === undefined ? undefined : feeMessages[input.fee]
  if (feeMessage) {
    return { reason: 'vip_required', message: feeMessage, ...base }
  }
  const rejected = input.tried.filter((item) => item.code !== undefined && item.code !== 200)
  if (rejected.length === input.tried.length && input.tried.length) {
    return {
      reason: 'no_url',
      message: `各音质档位均不可播放（${rejected.map((item) => `${item.level}:${item.code}`).join(' ')}），歌曲可能暂无版权或已下架`,
      ...base,
    }
  }
  if (input.requestError) {
    return { reason: 'request_failed', message: `音源接口请求失败：${input.requestError}`, ...base }
  }
  return { reason: 'no_url', message: '没有找到可播放的音源', ...base }
}

export const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) return error
  if (error instanceof Error) return new AppError('INTERNAL_ERROR', error.message)
  return new AppError('INTERNAL_ERROR', String(error))
}
