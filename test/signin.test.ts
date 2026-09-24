import { describe, expect, it } from 'vitest'
import { AppError } from '../src/core/errors.js'
import { NeteaseApi } from '../src/api/netease.js'

type Stub = (name: string, params: Record<string, unknown>) => Promise<unknown>

/** 用桩替换内部请求，只验证对接口真实字段的判定 */
const apiWith = (stub: Stub) => {
  const api: any = Object.create(NeteaseApi.prototype)
  api.getCookie = () => 'MUSIC_U=test'
  api.call = async (name: string, params: Record<string, unknown> = {}) => stub(name, params)
  return api as {
    signin: () => Promise<unknown>
    signinOverview: () => Promise<unknown>
    recentPlaylists: (limit?: number) => Promise<unknown>
    recentAlbums: (limit?: number) => Promise<unknown>
    recentRadios: (limit?: number) => Promise<unknown>
  }
}

const reject = (body: { msg?: string; code?: number }): never => {
  throw new AppError('API_REQUEST_FAILED', body.msg ?? '', body)
}

describe('signin 判定', () => {
  it('服务端返回「功能暂不支持」时不再报成签到成功', async () => {
    const api = apiWith(async () => ({ code: 200, msg: '功能暂不支持' }))
    const result = (await api.signin()) as {
      daily: { success: boolean; message: string }
      yunbei: { success: boolean }
    }
    expect(result.daily.success).toBe(false)
    expect(result.daily.message).toBe('功能暂不支持')
  })

  it('积分签到成功时读取 point', async () => {
    const api = apiWith(async (name) =>
      name === 'daily_signin'
        ? { code: 200, point: 3 }
        : { code: 200, data: { sign: true, yunbeiNum: 50 } },
    )
    const result = (await api.signin()) as {
      daily: { success: boolean; point?: number }
      yunbei: { success: boolean; point?: number }
    }
    expect(result.daily).toMatchObject({ success: true, repeated: false, point: 3 })
    expect(result.yunbei).toMatchObject({ success: true, point: 50 })
  })

  it('重复签到（code -2）识别为已完成', async () => {
    const api = apiWith(async (name) => {
      if (name === 'daily_signin') reject({ code: -2, msg: '重复签到' })
      return { code: 200, data: { sign: true, yunbeiNum: 50 } }
    })
    const result = (await api.signin()) as { daily: { success: boolean; repeated: boolean } }
    expect(result.daily).toMatchObject({ success: true, repeated: true, message: '今天已签到' })
  })

  it('云贝 sign 为 false 时如实报告未获得', async () => {
    const api = apiWith(async (name) =>
      name === 'daily_signin'
        ? { code: 200, point: 2 }
        : { code: 200, data: { sign: false }, message: '' },
    )
    const result = (await api.signin()) as {
      yunbei: { success: boolean; repeated: boolean; message: string }
    }
    expect(result.yunbei.success).toBe(false)
    expect(result.yunbei.repeated).toBe(false)
    expect(result.yunbei.message).toContain('未获得云贝')
  })

  it('未登录（code 301，body 无 msg）输出错误码而不是 [object Object]', async () => {
    const api = apiWith(async (name) => {
      if (name === 'daily_signin') reject({ code: 301 })
      return { code: 200, data: { sign: true, yunbeiNum: 1 } }
    })
    const result = (await api.signin()) as { daily: { success: boolean; message: string } }
    expect(result.daily.success).toBe(false)
    expect(result.daily.message).not.toContain('[object Object]')
    expect(result.daily.message.length).toBeGreaterThan(0)
  })
})

describe('signinOverview', () => {
  it('按真实字段汇总签到进度与账户信息', async () => {
    const api = apiWith(async (name) => {
      if (name === 'signin_progress')
        return {
          code: 200,
          data: {
            today: { todaySignedIn: true },
            records: [
              { day: '2026-09-24', signed: true },
              { day: '2026-09-23', signed: false },
            ],
            stats: [
              {
                id: 6001,
                description: '累计签到（不循环）',
                currentProgress: 597,
                maxProgressReached: 597,
                repeatType: 'NEVER',
                calcType: 'ACCUMULATE',
              },
            ],
          },
        }
      if (name === 'vip_growthpoint')
        return {
          code: 200,
          data: {
            userLevel: { level: 7, levelName: 'SVIP黑胶·柒', growthPoint: 26646, maxLevel: true },
          },
        }
      return { code: 200, level: 10, userPoint: { balance: 50 } }
    })
    expect(await api.signinOverview()).toEqual({
      todaySignedIn: true,
      records: [
        { day: '2026-09-24', signed: true },
        { day: '2026-09-23', signed: false },
      ],
      progress: [
        {
          id: 6001,
          description: '累计签到（不循环）',
          currentProgress: 597,
          maxProgressReached: 597,
          repeatType: 'NEVER',
          calcType: 'ACCUMULATE',
        },
      ],
      growth: { level: 7, levelName: 'SVIP黑胶·柒', growthPoint: 26646, maxLevel: true },
      yunbei: { level: 10, balance: 50 },
    })
  })

  it('单个接口失败时不影响其余部分', async () => {
    const api = apiWith(async (name) => {
      if (name !== 'signin_progress') throw new AppError('API_REQUEST_FAILED', 'boom')
      return { code: 200, data: { today: {}, records: [], stats: [] } }
    })
    expect(await api.signinOverview()).toEqual({
      todaySignedIn: false,
      records: [],
      progress: [],
    })
  })
})

describe('最近播放多类型', () => {
  const wrapper = (data: unknown) => ({ code: 200, data: { total: 2, list: [data] } })

  it('歌单取 coverImgUrl 且不编造曲目数', async () => {
    const api = apiWith(async () =>
      wrapper({
        resourceId: '8867900878',
        playTime: 1790235569230,
        resourceType: 'PLAYLIST',
        data: { id: 8867900878, name: '我的歌单', coverImgUrl: 'https://example/a.jpg' },
      }),
    )
    expect(await api.recentPlaylists(3)).toEqual([
      {
        id: 8867900878,
        name: '我的歌单',
        cover: 'https://example/a.jpg',
        playTime: 1790235569230,
      },
    ])
  })

  it('专辑用 size 作为曲目数', async () => {
    const api = apiWith(async () =>
      wrapper({
        playTime: 1783866089390,
        data: { id: 190605791, name: '专辑名', picUrl: 'https://example/b.jpg', size: 11 },
      }),
    )
    expect(await api.recentAlbums(3)).toEqual([
      {
        id: 190605791,
        name: '专辑名',
        cover: 'https://example/b.jpg',
        playTime: 1783866089390,
        count: 11,
      },
    ])
  })

  it('播客用 programCount', async () => {
    const api = apiWith(async () =>
      wrapper({
        playTime: 1785084827997,
        data: { id: 957855910, name: '电台', picUrl: 'x', programCount: 240 },
      }),
    )
    expect(await api.recentRadios(3)).toEqual([
      { id: 957855910, name: '电台', cover: 'x', playTime: 1785084827997, count: 240 },
    ])
  })

  it('丢掉 id 非法的条目', async () => {
    const api = apiWith(async () => ({
      code: 200,
      data: {
        list: [
          { playTime: 1, data: { id: null, name: '坏数据' } },
          { playTime: 2, data: { id: 7, name: '好' } },
        ],
      },
    }))
    expect(await api.recentPlaylists(3)).toEqual([{ id: 7, name: '好', playTime: 2 }])
  })
})
