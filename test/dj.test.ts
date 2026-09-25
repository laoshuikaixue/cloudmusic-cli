import { describe, expect, it } from 'vitest'
import { NeteaseApi } from '../src/api/netease.js'

type Stub = (name: string, params: Record<string, unknown>) => Promise<unknown>

const apiWith = (stub: Stub) => {
  const api: any = Object.create(NeteaseApi.prototype)
  api.getCookie = () => 'MUSIC_U=test'
  api.call = async (name: string, params: Record<string, unknown> = {}) => stub(name, params)
  return api as {
    djPrograms: (
      rid: number,
      name: string,
      limit?: number,
      offset?: number,
    ) => Promise<{ collection: unknown; songs: Record<string, unknown>[]; more: boolean }>
    searchRadios: (
      keywords: string,
      limit?: number,
      offset?: number,
    ) => Promise<{ items: Record<string, unknown>[]; total: number; hasMore: boolean }>
    subscribedRadios: (limit?: number, offset?: number) => Promise<Record<string, unknown>[]>
    hotRadios: (limit?: number, offset?: number) => Promise<Record<string, unknown>[]>
    radiosByCategory: (
      cateId: number,
      limit?: number,
      offset?: number,
    ) => Promise<Record<string, unknown>[]>
    radioCategories: () => Promise<{ id: number; name: string }[]>
  }
}

const program = (mainSong: unknown, extra: Record<string, unknown> = {}) => ({
  mainSong,
  name: 'ASOT 1295',
  duration: 7514801,
  ...extra,
})

describe('djPrograms', () => {
  it('把节目的 mainSong 还原成可播放歌曲', async () => {
    const api = apiWith(async () => ({
      code: 200,
      count: 512,
      more: true,
      programs: [
        program({
          id: 3439686663,
          name: 'A State Of Trance 1295',
          artists: [{ id: 1, name: 'A.T.' }],
          album: { id: 0, name: null },
          duration: 7514801,
          fee: 0,
        }),
      ],
    }))
    const result = await api.djPrograms(957855910, 'A State Of Trance', 50, 0)
    expect(result.songs).toHaveLength(1)
    expect(result.songs[0]).toMatchObject({
      id: 3439686663,
      name: 'A State Of Trance 1295',
      duration: 7514801,
    })
    expect(result.collection).toEqual({
      id: 957855910,
      name: 'A State Of Trance',
      type: 'radio',
      count: 512,
      countUnit: '期',
    })
    expect(result.more).toBe(true)
  })

  it('mainSong 没有时长时用节目时长兜底', async () => {
    const api = apiWith(async () => ({
      count: 1,
      programs: [program({ id: 123, name: '单集', artists: [], album: {} })],
    }))
    const result = await api.djPrograms(1, '电台')
    expect(result.songs[0]?.duration).toBe(7514801)
  })

  it('丢掉没有合法 mainSong 的节目', async () => {
    const api = apiWith(async () => ({
      programs: [
        program(null),
        program({ id: 0, name: '坏' }),
        program({ id: undefined, name: '坏' }),
        program({ id: 555, name: '好', artists: [], album: {} }),
      ],
    }))
    const result = await api.djPrograms(7, '电台')
    expect(result.songs.map((song) => song.id)).toEqual([555])
    // count 不可用时退回已加载条数
    expect(result.collection).toMatchObject({ count: 1, countUnit: '期' })
  })

  it('缺少电台名时退回占位标题', async () => {
    const api = apiWith(async () => ({ programs: [] }))
    const result = await api.djPrograms(42, '')
    expect(result.collection).toMatchObject({ id: 42, name: '播客节目', count: 0 })
  })
})

describe('播客发现页', () => {
  const radio = { id: 957855910, name: 'A State Of Trance', programCount: 1300 }

  it('dj_sublist 取订阅电台，只读 djRadios', async () => {
    const calls: Array<{ name: string; params: Record<string, unknown> }> = []
    const api = apiWith(async (name, params) => {
      calls.push({ name, params })
      return { count: 1, djRadios: [radio], hasMore: true, code: 200 }
    })
    const items = await api.subscribedRadios(30, 0)
    expect(calls[0]).toEqual({ name: 'dj_sublist', params: { limit: 30, offset: 0 } })
    expect(items).toEqual([
      { id: 957855910, name: 'A State Of Trance', type: 'radio', count: 1300, countUnit: '期' },
    ])
  })

  it('dj_hot 取热门电台，接口没有 count 字段', async () => {
    const seen: string[] = []
    const api = apiWith(async (name) => {
      seen.push(name)
      return { djRadios: [radio], hasMore: false }
    })
    expect(await api.hotRadios(10, 20)).toHaveLength(1)
    expect(seen).toEqual(['dj_hot'])
  })

  it('dj_radio_hot 用分类接口返回的 cateId 请求', async () => {
    let params: Record<string, unknown> = {}
    const api = apiWith(async (name, input) => {
      params = input
      return name === 'dj_catelist' ? { categories: [{ name: '情感', id: 3 }] } : { djRadios: [] }
    })
    const categories = await api.radioCategories()
    expect(categories).toEqual([{ id: 3, name: '情感' }])
    await api.radiosByCategory(categories[0]!.id, 30, 0)
    expect(params).toEqual({ cateId: 3, limit: 30, offset: 0 })
  })

  it('分类列表丢掉没有 id 或名称的条目', async () => {
    const api = apiWith(async () => ({
      categories: [
        { name: '音乐播客', id: 2, picUrl: 'https://example/a.jpg' },
        { name: '  ', id: 5 },
        { name: '缺 id' },
        { name: '浮点 id', id: 1.5 },
      ],
    }))
    expect(await api.radioCategories()).toEqual([{ id: 2, name: '音乐播客' }])
  })

  it('接口返回空列表时不抛错', async () => {
    const api = apiWith(async () => ({}))
    expect(await api.subscribedRadios()).toEqual([])
    expect(await api.hotRadios()).toEqual([])
    expect(await api.radiosByCategory(3)).toEqual([])
    expect(await api.radioCategories()).toEqual([])
  })
})

describe('searchRadios', () => {
  it('把 result.djRadios 转成可播放的电台条目', async () => {
    const api = apiWith(async (name, params) => {
      expect(name).toBe('cloudsearch')
      expect(params.type).toBe(1009)
      return {
        code: 200,
        result: {
          djRadiosCount: 42,
          hasMore: true,
          djRadios: [
            {
              id: 957855910,
              name: 'A State Of Trance',
              picUrl: 'https://example/radio.jpg',
              dj: { nickname: 'A.T.' },
              programCount: 1300,
              category: '欧美电音',
            },
          ],
        },
      }
    })
    const result = await api.searchRadios('trance', 20, 0)
    expect(result.total).toBe(42)
    expect(result.hasMore).toBe(true)
    expect(result.items).toEqual([
      {
        id: 957855910,
        name: 'A State Of Trance',
        type: 'radio',
        cover: 'https://example/radio.jpg',
        subtitle: 'A.T.',
        count: 1300,
        countUnit: '期',
      },
    ])
  })

  it('没有主播昵称时退回分类，两者都缺时不编造副标题', async () => {
    const api = apiWith(async () => ({
      result: {
        djRadios: [
          { id: 1, name: '只有分类', category: '情感' },
          { id: 2, name: '什么都没有' },
          { id: 3, name: '空白昵称', dj: { nickname: '  ' }, programCount: 0 },
        ],
      },
    }))
    expect(await api.searchRadios('x')).toMatchObject({
      total: 0,
      hasMore: false,
    })
    const items = (await api.searchRadios('x')).items
    expect(items[0]).not.toHaveProperty('cover')
    expect(items[0]?.subtitle).toBe('情感')
    expect(items[1]).not.toHaveProperty('subtitle')
    expect(items[1]).not.toHaveProperty('count')
    expect(items[2]?.subtitle).toBe(undefined)
  })

  it('节目数为字符串时也能解析，名称缺失时用占位', async () => {
    const api = apiWith(async () => ({
      result: { djRadios: [{ id: 7, programCount: '12' }] },
    }))
    const [item] = (await api.searchRadios('y')).items
    expect(item).toMatchObject({ name: '未命名电台', count: 12, countUnit: '期' })
  })
})
