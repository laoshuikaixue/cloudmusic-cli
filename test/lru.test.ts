import { describe, expect, it } from 'vitest'
import { LruMap } from '../src/core/lru.js'

describe('LruMap', () => {
  it('超出容量时淘汰最久未使用的条目', () => {
    const cache = new LruMap<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(2)
  })

  it('同键写入会覆盖而不是撑大容量', () => {
    const cache = new LruMap<string, number>(1)
    cache.set('a', 1)
    cache.set('a', 2)
    expect(cache.size).toBe(1)
    expect(cache.get('a')).toBe(2)
  })

  it('带 TTL 的条目过期后不再命中', () => {
    const cache = new LruMap<string, number>(4)
    cache.set('short', 1, -1)
    expect(cache.get('short')).toBeUndefined()
    cache.set('long', 2, 60_000)
    expect(cache.get('long')).toBe(2)
  })
})
