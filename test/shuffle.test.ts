import { describe, expect, it } from 'vitest'
import {
  addShuffleIds,
  newShuffleState,
  nextShuffleIndex,
  previousShuffleIndex,
  removeShuffleId,
  trackShuffleJump,
} from '../src/daemon/shuffle.js'

const songs = [1, 2, 3, 4, 5].map((id) => ({ id }))

describe('nextShuffleIndex', () => {
  it('plays every song exactly once before repeating any', () => {
    let state = newShuffleState(songs, 0)
    let index = 0
    const played = new Set<number>([songs[index]!.id])
    for (let step = 0; step < songs.length - 1; step++) {
      const result = nextShuffleIndex(songs, index, state)
      state = result.state
      index = result.index
      const songId = songs[index]!.id
      expect(played.has(songId)).toBe(false)
      played.add(songId)
    }
    expect(played.size).toBe(songs.length)
  })

  it('starts a new round without the current song when the pool is empty', () => {
    let state = newShuffleState(songs, 0)
    let index = 0
    for (let step = 0; step < songs.length - 1; step++) {
      const result = nextShuffleIndex(songs, index, state)
      state = result.state
      index = result.index
    }
    expect(state.pool).toHaveLength(0)
    const round2 = nextShuffleIndex(songs, index, state)
    // 新轮:除当前歌曲外的 4 首,抽取 1 首后剩 3 首;回退历史保留并可回到当前歌曲
    expect(round2.state.pool).toHaveLength(songs.length - 2)
    expect(round2.state.pool).not.toContain(songs[index]!.id)
    expect(round2.state.history).toHaveLength(songs.length)
    expect(round2.state.history.at(-1)).toBe(songs[index]!.id)
    expect(round2.index).not.toBe(index)
  })

  it('replays the only song when the queue holds a single unique song', () => {
    const single = [{ id: 1 }]
    const result = nextShuffleIndex(single, 0, newShuffleState(single))
    expect(result.index).toBe(0)
  })

  it('deduplicates repeated song ids within a round', () => {
    const duplicated = [{ id: 1 }, { id: 1 }, { id: 2 }]
    const state = newShuffleState(duplicated)
    expect([...state.pool].sort()).toEqual([1, 2])
    let index = 0
    let current = state
    const played = new Set<number>([duplicated[index]!.id])
    const result = nextShuffleIndex(duplicated, index, current)
    current = result.state
    index = result.index
    played.add(duplicated[index]!.id)
    expect([...played].sort()).toEqual([1, 2])
  })

  it('ignores stale ids left in the pool', () => {
    const stale = { pool: [99, 4, 5], history: [] }
    const result = nextShuffleIndex(songs, 0, stale)
    expect(result.state.pool).not.toContain(99)
    expect([4, 5]).toContain(songs[result.index]!.id)
  })
})

describe('previousShuffleIndex', () => {
  it('goes back to the most recently left song and returns the current song to the pool', () => {
    const state = { pool: [2, 4], history: [1, 3] }
    const result = previousShuffleIndex(songs, 4, state)
    expect(result).not.toBeNull()
    expect(result!.index).toBe(2)
    expect(result!.state.pool.sort()).toEqual([2, 4, 5])
    expect(result!.state.history).toEqual([1])
  })

  it('returns null when there is no history to fall back to', () => {
    const result = previousShuffleIndex(songs, 0, { pool: [2, 3, 4, 5], history: [] })
    expect(result).toBeNull()
  })

  it('skips history entries whose songs were removed from the queue', () => {
    const shrunk = songs.filter((song) => song.id !== 3)
    const state = { pool: [4, 5], history: [1, 2, 3] }
    const result = previousShuffleIndex(shrunk, 3, state)
    expect(result).not.toBeNull()
    expect(result!.index).toBe(1)
    expect(result!.state.history).toEqual([1])
  })
})

describe('trackShuffleJump', () => {
  it('records the current song and removes the target from the pool', () => {
    const state = { pool: [2, 3, 4, 5], history: [] }
    const next = trackShuffleJump(songs, 0, 3, state)
    expect(next.history).toEqual([1])
    expect(next.pool).toEqual([2, 4, 5])
  })

  it('keeps history and pool untouched when jumping to the current song', () => {
    const state = { pool: [2, 3, 4, 5], history: [9] }
    const next = trackShuffleJump(songs, 0, 1, state)
    expect(next.history).toEqual([9])
    expect(next.pool).toEqual([2, 3, 4, 5])
  })
})

describe('addShuffleIds / removeShuffleId', () => {
  it('adds new ids to the pool without duplicates', () => {
    const state = { pool: [1, 2], history: [] }
    const next = addShuffleIds(state, [2, 3])
    expect(next.pool.sort()).toEqual([1, 2, 3])
  })

  it('removes an id from the pool while keeping history', () => {
    const state = { pool: [1, 2, 3], history: [4] }
    const next = removeShuffleId(state, 2)
    expect(next.pool).toEqual([1, 3])
    expect(next.history).toEqual([4])
  })
})

describe('回退栈上限', () => {
  it('长时间随机切歌后回退栈不会超过队列歌曲数', () => {
    let state = newShuffleState(songs, 0)
    let index = 0
    for (let step = 0; step < 200; step++) {
      const result = nextShuffleIndex(songs, index, state)
      state = result.state
      index = result.index
      expect(state.history.length).toBeLessThanOrEqual(songs.length)
    }
  })

  it('反复手动跳转同样收紧回退栈', () => {
    let state = newShuffleState(songs, 0)
    for (let step = 0; step < 60; step++) {
      state = trackShuffleJump(songs, step % songs.length, ((step + 2) % songs.length) + 1, state)
      expect(state.history.length).toBeLessThanOrEqual(songs.length)
    }
  })
})
