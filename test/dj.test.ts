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
