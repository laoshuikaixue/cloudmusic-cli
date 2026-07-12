import { describe, expect, it } from 'vitest'
import { normalizePlaylist, normalizeSong } from '../src/api/netease.js'

describe('normalizeSong', () => {
  it('normalizes cloud search shapes', () => {
    expect(
      normalizeSong({
        id: 186016,
        name: '晴天',
        ar: [{ id: 6452, name: '周杰伦' }],
        al: { id: 18905, name: '叶惠美', picUrl: 'cover' },
        dt: 269000,
      }),
    ).toMatchObject({
      id: 186016,
      name: '晴天',
      artists: [{ id: 6452, name: '周杰伦' }],
      album: { id: 18905, name: '叶惠美', cover: 'cover' },
      duration: 269000,
    })
  })
})

describe('normalizePlaylist', () => {
  it('normalizes user playlist metadata', () => {
    expect(
      normalizePlaylist({
        id: 9265368428,
        name: '体能训练',
        coverImgUrl: 'cover',
        trackCount: 3,
        creator: { userId: 5035092974, nickname: 'LaoShui_' },
      }),
    ).toEqual({
      id: 9265368428,
      name: '体能训练',
      cover: 'cover',
      trackCount: 3,
      description: undefined,
      creator: { id: 5035092974, name: 'LaoShui_' },
      subscribed: false,
    })
  })
})
