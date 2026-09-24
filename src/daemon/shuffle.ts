/**
 * 随机播放的"不重复轮次"逻辑。
 *
 * 以"未播放池 + 回退历史"为核心:每次取下一首都从池中随机抽取并移除,
 * 池抽空后开启新的一轮(排除当前歌曲,避免刚播完立刻重播),
 * 从而保证列表内每首歌在全部播放结束之前最多播放一次。
 */

export interface ShuffleState {
  /** 本轮尚未播放的歌曲 id(顺序无关,抽取时随机) */
  pool: number[]
  /** 已切走的歌曲 id 回退栈,栈顶为最近一次切走的歌曲 */
  history: number[]
}

const uniqueIds = (songs: Array<{ id: number }>): number[] => [
  ...new Set(songs.map((song) => song.id)),
]

/** 回退栈不需要超过队列长度，超出部分永远不会再被用到 */
const pushHistory = (history: number[], id: number | undefined, songs: Array<{ id: number }>) => {
  if (id === undefined) return history
  const limit = Math.max(1, uniqueIds(songs).length)
  const next = [...history, id]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** 初始化一轮:池中包含队列全部歌曲(去重),排除当前正在播放的歌曲 */
export function newShuffleState(songs: Array<{ id: number }>, currentIndex = -1): ShuffleState {
  const currentId = songs[currentIndex]?.id
  const pool = uniqueIds(songs).filter((id) => id !== currentId)
  return { pool, history: [] }
}

export function emptyShuffleState(): ShuffleState {
  return { pool: [], history: [] }
}

export interface ShuffleNext {
  index: number
  state: ShuffleState
}

/** 取下一首的队列索引;无法选取时(队列仅剩当前歌曲)原地重播 */
export function nextShuffleIndex(
  songs: Array<{ id: number }>,
  currentIndex: number,
  state: ShuffleState,
): ShuffleNext {
  const currentId = songs[currentIndex]?.id
  const validIds = new Set(uniqueIds(songs))
  const pool = state.pool.filter((id) => validIds.has(id))
  let candidates = pool.filter((id) => id !== currentId)
  const history = state.history
  let freshRound = false
  if (!candidates.length) {
    // 本轮全部播完:开启新的一轮,排除当前歌曲避免紧接重播
    candidates = uniqueIds(songs).filter((id) => id !== currentId)
    freshRound = true
    if (!candidates.length) return { index: currentIndex, state: { pool, history } }
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)]
  const nextPool = (freshRound ? candidates : pool).filter((id) => id !== pick)
  const nextHistory = pushHistory(history, currentId, songs)
  return {
    index: songs.findIndex((song) => song.id === pick),
    state: { pool: nextPool, history: nextHistory },
  }
}

/** 回退上一首:返回 null 表示没有可回退的历史 */
export function previousShuffleIndex(
  songs: Array<{ id: number }>,
  currentIndex: number,
  state: ShuffleState,
): ShuffleNext | null {
  const history = [...state.history]
  while (history.length) {
    const backId = history.pop() as number
    const backIndex = songs.findIndex((song) => song.id === backId)
    if (backIndex >= 0 && backIndex !== currentIndex) {
      // 当前歌曲放回未播放池,后续随机时仍可能再次抽到
      const currentId = songs[currentIndex]?.id
      const pool =
        currentId !== undefined && !state.pool.includes(currentId)
          ? [...state.pool, currentId]
          : state.pool
      return { index: backIndex, state: { pool, history } }
    }
  }
  return null
}

/** 手动跳转到指定歌曲:记录被切走的当前歌曲,并把目标歌曲移出未播放池 */
export function trackShuffleJump(
  songs: Array<{ id: number }>,
  currentIndex: number,
  targetId: number,
  state: ShuffleState,
): ShuffleState {
  const currentId = songs[currentIndex]?.id
  const history =
    currentId !== undefined && currentId !== targetId
      ? pushHistory(state.history, currentId, songs)
      : state.history
  const pool = currentId === targetId ? state.pool : state.pool.filter((id) => id !== targetId)
  return { pool, history }
}

/** 队列新增歌曲时,把新歌 id 并入未播放池(去重) */
export function addShuffleIds(state: ShuffleState, ids: number[]): ShuffleState {
  const pool = new Set(state.pool)
  for (const id of ids) pool.add(id)
  return { pool: [...pool], history: state.history }
}

/** 队列移除歌曲时,从未播放池中剔除对应 id */
export function removeShuffleId(state: ShuffleState, id: number): ShuffleState {
  return { pool: state.pool.filter((value) => value !== id), history: state.history }
}
