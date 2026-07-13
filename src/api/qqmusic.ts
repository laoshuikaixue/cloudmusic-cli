/**
 * QQ 音乐匿名搜索与 QRC 歌词获取。
 * 请求结构参考 SPlayer-Next 的 QM 原生 API 模块。
 */
import { decryptQrc } from './qrc.js'

const API_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const headers = {
  'Content-Type': 'application/json',
  'Accept-Encoding': 'gzip',
  'User-Agent': 'okhttp/3.14.9',
  Referer: 'https://y.qq.com',
  Cookie: 'tmeLoginType=-1;',
}

interface SessionCache {
  uid?: string
  sid?: string
  userip?: string
  expiresAt: number
}

export interface QqSongCandidate {
  id: string
  mid: string
  name: string
  artist: string
  album: string
  duration: number
}

export interface QqLyricResponse {
  qrc?: string
  lrc?: string
  translation?: string
  romanization?: string
}

let session: SessionCache = { expiresAt: 0 }
let sessionPromise: Promise<void> | undefined
const lyricCache = new Map<string, QqLyricResponse>()

const commonParams = () => ({
  ct: 11,
  cv: '1003006',
  v: '1003006',
  os_ver: '15',
  phonetype: '24122RKC7C',
  tmeAppID: 'qqmusiclight',
  nettype: 'NETWORK_WIFI',
  udid: '0',
  OpenUDID: '0',
  QIMEI36: '0',
  uin: '0',
})

const post = async (body: unknown) => {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`QQ Music HTTP ${response.status}`)
  return response.json() as Promise<any>
}

const ensureSession = async () => {
  if (session.uid && session.expiresAt > Date.now()) return
  if (sessionPromise) return sessionPromise
  sessionPromise = (async () => {
    try {
      const response = await post({
        comm: commonParams(),
        request: {
          module: 'music.getSession.session',
          method: 'GetSession',
          param: { caller: 0, uid: '0', vkey: 0 },
        },
      })
      const value = response?.request?.data?.session || {}
      session = {
        uid: value.uid,
        sid: value.sid,
        userip: value.userip,
        expiresAt: Date.now() + 60 * 60 * 1000,
      }
    } catch {
      session = { expiresAt: 0 }
    } finally {
      sessionPromise = undefined
    }
  })()
  return sessionPromise
}

const request = async <T>(module: string, method: string, param: Record<string, unknown>) => {
  await ensureSession()
  const comm = {
    ...commonParams(),
    ...(session.uid ? { uid: session.uid } : {}),
    ...(session.sid ? { sid: session.sid } : {}),
    ...(session.userip ? { userip: session.userip } : {}),
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await post({ comm, request: { module, method, param } })
      if ((response?.code ?? 0) !== 0 || (response?.request?.code ?? 0) !== 0) {
        throw new Error(`QQ Music API ${response?.code ?? 0}/${response?.request?.code ?? 0}`)
      }
      return response.request.data as T
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw lastError
}

const searchId = () =>
  String(
    Math.floor(Math.random() * 20) * 18014398509481984 +
      Math.floor(Math.random() * 4194304) * 4294967296 +
      (Date.now() % 86400000),
  )

export const searchQqSongs = async (keywords: string, limit = 15): Promise<QqSongCandidate[]> => {
  const response = await request<any>('music.search.SearchCgiService', 'DoSearchForQQMusicMobile', {
    search_id: searchId(),
    remoteplace: 'search.android.keyboard',
    query: keywords,
    search_type: 0,
    num_per_page: limit,
    page_num: 1,
    highlight: 0,
    nqc_flag: 0,
    multi_zhida: 0,
    cat: 2,
    grp: 1,
    sin: 0,
    sem: 0,
    page_id: 1,
  })
  return (response?.body?.item_song || []).map((song: any) => ({
    id: String(song.id),
    mid: String(song.mid || ''),
    name: String(song.title || ''),
    artist: (song.singer || [])
      .map((artist: any) => artist?.name)
      .filter(Boolean)
      .join(' / '),
    album: String(song.album?.name || ''),
    duration: Number(song.interval || 0) * 1000,
  }))
}

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

export const getQqLyrics = async (candidate: QqSongCandidate): Promise<QqLyricResponse> => {
  const cached = lyricCache.get(candidate.id)
  if (cached) return cached
  const params = {
    albumName: base64(candidate.album),
    crypt: 1,
    ct: 19,
    cv: 2111,
    interval: Math.round(candidate.duration / 1000),
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    singerName: base64(candidate.artist),
    songID: Number(candidate.id),
    songName: base64(candidate.name),
    trans: 1,
    trans_t: 0,
    type: 0,
  }
  const response = await request<any>(
    'music.musichallSong.PlayLyricInfo',
    'GetPlayLyricInfo',
    params,
  )
  const main = decryptQrc(response?.lyric)
  const result: QqLyricResponse = {}
  if (main) {
    if (response?.qrc_t === 0) result.lrc = main
    else result.qrc = main
  }
  if (result.qrc && !result.lrc) {
    try {
      const lrcResponse = await request<any>(
        'music.musichallSong.PlayLyricInfo',
        'GetPlayLyricInfo',
        { ...params, qrc: 0, qrc_t: 0 },
      )
      result.lrc = decryptQrc(lrcResponse?.lyric)
    } catch {
      // QRC 已可用时，LRC 回退请求失败不影响结果。
    }
  }
  result.translation = decryptQrc(response?.trans)
  result.romanization = decryptQrc(response?.roma)
  lyricCache.set(candidate.id, result)
  return result
}
