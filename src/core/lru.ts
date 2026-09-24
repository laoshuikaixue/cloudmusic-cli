/** 带可选过期时间的 LRU Map，用于限制常驻 daemon 的缓存规模。 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number | undefined }>()

  constructor(private readonly max: number) {}

  get size() {
    return this.entries.size
  }

  get(key: K): V | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (hit.expiresAt !== undefined && hit.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // 重新插入以刷新最近使用顺序
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value
  }

  set(key: K, value: V, ttlMilliseconds?: number) {
    this.entries.delete(key)
    this.entries.set(key, {
      value,
      expiresAt: ttlMilliseconds === undefined ? undefined : Date.now() + ttlMilliseconds,
    })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  delete(key: K) {
    this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }
}
