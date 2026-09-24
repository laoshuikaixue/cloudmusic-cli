import { createRequire } from 'node:module'
import { AppError, describeSourceFailure, SourceUnavailableError } from '../core/errors.js'
import { qualityChain } from '../core/config.js'
import { LruMap } from '../core/lru.js'
import { parseNeteaseLyrics } from '../core/lyrics.js'
import { upgradeLyrics } from './lyric-upgrade.js'
import type {
  AppConfig,
  CloudLibrary,
  CollectionSummary,
  ListeningRecordEntry,
  ListenReport,
  ListenStats,
  LyricResult,
  CommentPage,
  MusicComment,
  NewSongArea,
  PlaylistSummary,
  QueueContext,
  RecentPlayEntry,
  RecentResourceEntry,
  ScrobbleMode,
  SigninOverview,
  SigninResult,
  SigninTaskResult,
  Song,
  SourceFailure,
  SourceResult,
  TodayListenSong,
  UserProfile,
} from '../core/types.js'

const require = createRequire(import.meta.url)
process.env.DOTENV_CONFIG_QUIET ??= 'true'
const api = require('@neteasecloudmusicapienhanced/api') as Record<
  string,
  (params?: Record<string, unknown>) => Promise<any>
>

let initializePromise: Promise<void> | undefined

const bodyOf = <T = any>(response: any): T => (response?.body ?? response) as T

/** 依赖库以 { status, body } 形态抛出错误，body 里没有 message，需要按真实字段取值 */
const apiErrorMessage = (error: any): string => {
  const body = typeof error?.body === 'object' && error?.body !== null ? error.body : undefined
  const text = body?.message || body?.msg
  if (typeof text === 'string' && text.trim()) return text.trim()
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim()
  if (typeof body?.code === 'number') return `接口返回错误码 ${body.code}`
  return '未知错误'
}

/** 依赖库会把错误响应和解灰后的播放地址写到 stdout，这里改道 stderr 并抹掉凭据与签名地址 */
let stdoutGuardDepth = 0
const REDACTED = '[已隐藏]'
const sensitiveKey = /^(cookie|set-cookie|__csrf|music_u|osver|deviceid)$/i
const signedUrlPattern = /https?:\/\/\S{60,}/gi
const signedUrlTest = /https?:\/\/\S{60,}/i

const toSafeText = (value: unknown): string => {
  const stringify = (input: unknown): string => {
    if (typeof input === 'string') return input.replace(signedUrlPattern, REDACTED)
    if (typeof input === 'object' && input !== null) {
      return JSON.stringify(input, (key, item) =>
        sensitiveKey.test(key) || (typeof item === 'string' && signedUrlTest.test(item))
          ? REDACTED
          : stringify(item),
      )
    }
    return String(input)
  }
  return stringify(value)
}

const withStdoutGuard = async <T>(operation: () => Promise<T>): Promise<T> => {
  const originals: [typeof console.log, typeof console.info, typeof console.warn] = [
    console.log,
    console.info,
    console.warn,
  ]
  if (stdoutGuardDepth === 0) {
    const write = (...args: unknown[]) => {
      process.stderr.write(`${args.map(toSafeText).join(' ')}\n`)
    }
    console.log = write
    console.info = write
    console.warn = write
  }
  stdoutGuardDepth += 1
  try {
    return await operation()
  } finally {
    stdoutGuardDepth -= 1
    if (stdoutGuardDepth === 0) {
      console.log = originals[0]
      console.info = originals[1]
      console.warn = originals[2]
    }
  }
}

const normalizeArtists = (raw: any): Song['artists'] => {
  const artists = raw?.ar || raw?.artists || raw?.artist || []
  const list = Array.isArray(artists) ? artists : [artists]
  return list.filter(Boolean).map((artist) => ({
    id: Number.isFinite(Number(artist?.id)) ? Number(artist.id) : undefined,
    name: typeof artist === 'string' ? artist : String(artist?.name || '未知歌手'),
  }))
}

export const normalizeSong = (raw: any): Song => {
  const album = raw?.al || raw?.album || {}
  const duration = Number(raw?.dt || raw?.duration || 0)
  return {
    id: Number(raw?.id),
    name: String(raw?.name || '未知歌曲'),
    artists: normalizeArtists(raw),
    album: {
      id: Number.isFinite(Number(album?.id)) ? Number(album.id) : undefined,
      name: typeof album === 'string' ? album : String(album?.name || '未知专辑'),
      cover: album?.picUrl,
    },
    duration,
    cover: raw?.picUrl || album?.picUrl,
    fee: Number(raw?.fee || 0),
  }
}

export const normalizePlaylist = (raw: any): PlaylistSummary => ({
  id: Number(raw?.id),
  name: String(raw?.name || '未命名歌单'),
  cover: raw?.coverImgUrl || raw?.picUrl,
  trackCount: Number(raw?.trackCount || raw?.trackIds?.length || raw?.tracks?.length || 0),
  description: raw?.description ? String(raw.description) : undefined,
  creator: raw?.creator
    ? {
        id: Number.isFinite(Number(raw.creator.userId)) ? Number(raw.creator.userId) : undefined,
        name: String(raw.creator.nickname || '未知用户'),
      }
    : undefined,
  subscribed: Boolean(raw?.subscribed),
  specialType: Number(raw?.specialType || 0),
  updateFrequency: raw?.updateFrequency ? String(raw.updateFrequency) : undefined,
})

const newSongAreaNames: Record<NewSongArea, string> = {
  0: '全部新歌',
  7: '华语新歌',
  96: '欧美新歌',
  8: '日本新歌',
  16: '韩国新歌',
}

const normalizeComment = (raw: any): MusicComment => ({
  id: Number(raw?.commentId || raw?.id),
  content: String(raw?.content || ''),
  time: Number(raw?.time || 0),
  likedCount: Number(raw?.likedCount || 0),
  liked: Boolean(raw?.liked),
  user: {
    id: Number(raw?.user?.userId || 0),
    nickname: String(raw?.user?.nickname || '网易云用户'),
    avatar: raw?.user?.avatarUrl,
  },
})

export class NeteaseApi {
  private readonly lyricCache = new LruMap<number, Promise<LyricResult>>(200)
  private readonly upgradedLyricCache = new LruMap<string, Promise<LyricResult>>(200)
  private readonly sourceCache = new LruMap<string, SourceFailure>(100)

  constructor(private readonly getCookie: () => string) {}

  async initialize() {
    if (!initializePromise) {
      initializePromise = (async () => {
        try {
          const generateConfig =
            require('@neteasecloudmusicapienhanced/api/generateConfig.js') as () => Promise<void> | void
          await generateConfig()
        } catch (error) {
          initializePromise = undefined
          throw new AppError(
            'API_INIT_FAILED',
            '网易云 API 初始化失败，无法生成匿名凭据或 XEAPI 公钥',
            error instanceof Error ? error.message : String(error),
          )
        }
      })()
    }
    await initializePromise
  }

  private async call<T = any>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const fn = api[name]
    if (typeof fn !== 'function') throw new AppError('API_NOT_FOUND', `API 不支持 ${name}`)
    await this.initialize()
    try {
      const cookie = this.getCookie()
      return await withStdoutGuard(async () =>
        bodyOf<T>(await fn({ ...params, ...(cookie ? { cookie } : {}) })),
      )
    } catch (error: any) {
      throw new AppError(
        'API_REQUEST_FAILED',
        `${name} 请求失败：${apiErrorMessage(error)}`,
        error?.body,
      )
    }
  }

  async search(keywords: string, limit = 20, offset = 0) {
    const result = await this.call<any>('cloudsearch', { keywords, type: 1, limit, offset })
    return {
      songs: (result?.result?.songs || []).map(normalizeSong),
      total: Number(result?.result?.songCount || 0),
      hasMore: Boolean(result?.result?.hasMore),
    }
  }

  async searchPlaylists(keywords: string, limit = 20, offset = 0) {
    const result = await this.call<any>('cloudsearch', { keywords, type: 1000, limit, offset })
    return {
      items: (result?.result?.playlists || []).map(normalizePlaylist),
      total: Number(result?.result?.playlistCount || 0),
      hasMore: Boolean(result?.result?.hasMore),
    }
  }

  async searchAlbums(keywords: string, limit = 20, offset = 0) {
    const result = await this.call<any>('cloudsearch', { keywords, type: 10, limit, offset })
    return {
      items: (result?.result?.albums || []).map((album: any) => ({
        id: Number(album?.id),
        name: String(album?.name || '未知专辑'),
        type: 'album' as const,
        cover: album?.picUrl,
        subtitle: (album?.artists || [])
          .map((artist: any) => artist?.name)
          .filter(Boolean)
          .join(' / '),
        count: Number(album?.size || 0),
      })),
      total: Number(result?.result?.albumCount || 0),
      hasMore: Boolean(result?.result?.hasMore),
    }
  }

  async searchArtists(keywords: string, limit = 20, offset = 0) {
    const result = await this.call<any>('cloudsearch', { keywords, type: 100, limit, offset })
    return {
      items: (result?.result?.artists || []).map((artist: any) => ({
        id: Number(artist?.id),
        name: String(artist?.name || '未知歌手'),
        type: 'artist' as const,
        cover: artist?.picUrl || artist?.img1v1Url,
        subtitle: artist?.alias?.length ? artist.alias.join(' / ') : undefined,
        count: Number(artist?.musicSize || 0),
      })),
      total: Number(result?.result?.artistCount || 0),
      hasMore: Boolean(result?.result?.hasMore),
    }
  }

  /** 搜索关键词联想（输入补全） */
  async searchSuggest(keywords: string): Promise<string[]> {
    const result = await this.call<any>('search_suggest', { keywords, type: 'mobile' })
    const items = (result?.result?.allMatch || []).map((item: any) => String(item?.keyword || ''))
    return [...new Set<string>(items.filter(Boolean))].slice(0, 8)
  }

  async songDetail(id: number) {
    const result = await this.call<any>('song_detail', { ids: String(id) })
    const raw = result?.songs?.[0]
    if (!raw) throw new AppError('SONG_NOT_FOUND', `未找到歌曲 ${id}`)
    return normalizeSong(raw)
  }

  /** 副歌起止时间（毫秒），无副歌数据时返回 null */
  async chorus(id: number): Promise<{ startTime: number; endTime: number } | null> {
    const result = await this.call<any>('song_chorus', { id })
    const raw = (result?.chorus || result?.data || []).find(
      (item: any) => Number(item?.startTime) > 0,
    )
    if (!raw) return null
    return { startTime: Number(raw.startTime), endTime: Number(raw.endTime || 0) }
  }

  async similarSongs(id: number, limit = 20): Promise<Song[]> {
    const result = await this.call<any>('simi_song', { id, limit })
    return (result?.songs || []).map(normalizeSong)
  }

  async similarPlaylists(id: number, limit = 20): Promise<PlaylistSummary[]> {
    const result = await this.call<any>('simi_playlist', { id, limit })
    return (result?.playlists || []).map(normalizePlaylist)
  }

  async similarArtists(id: number): Promise<CollectionSummary[]> {
    const result = await this.call<any>('simi_artist', { id })
    return (result?.artists || []).map((artist: any) => ({
      id: Number(artist?.id),
      name: String(artist?.name || '未知歌手'),
      type: 'artist' as const,
      cover: artist?.picUrl || artist?.img1v1Url,
      subtitle: artist?.alias?.length ? artist.alias.join(' / ') : undefined,
      count: Number(artist?.musicSize || 0),
    }))
  }

  async lyrics(id: number): Promise<LyricResult> {
    let promise = this.lyricCache.get(id)
    if (!promise) {
      promise = this.call<any>('lyric_new', { id }).then((raw) => {
        const parsed = parseNeteaseLyrics(raw)
        return {
          lines: parsed.lines,
          format: parsed.format,
          source: 'netease',
          upgraded: false,
          raw,
        }
      })
      // 失败不缓存，避免预载失败后污染正式加载
      promise.catch(() => this.lyricCache.delete(id))
      this.lyricCache.set(id, promise)
    }
    return promise
  }

  async upgradedLyrics(song: Song, config: AppConfig, base?: LyricResult): Promise<LyricResult> {
    const key = [
      song.id,
      config.lyrics.upgrade ? 1 : 0,
      config.lyrics.enableTtml ? 1 : 0,
      config.lyrics.enableQrc ? 1 : 0,
      config.lyrics.amllDbServer,
    ].join(':')
    let promise = this.upgradedLyricCache.get(key)
    if (!promise) {
      promise = (base ? Promise.resolve(base) : this.lyrics(song.id)).then((official) =>
        upgradeLyrics(song, official, config),
      )
      promise.catch(() => this.upgradedLyricCache.delete(key))
      this.upgradedLyricCache.set(key, promise)
    }
    return promise
  }

  /** 按音质阶梯解析可播放音源；全部不可用时抛出带分类原因的 SOURCE_UNAVAILABLE */
  async resolveSource(id: number, config: AppConfig): Promise<SourceResult> {
    const chain = qualityChain(config.quality, config.qualityFallback)
    if (!chain.length) {
      throw new SourceUnavailableError({
        reason: 'no_url',
        message: `无法识别的音质设置：${config.quality}`,
      })
    }
    const cacheKey = [
      id,
      chain.join('>'),
      config.unblock.enabled ? 1 : 0,
      config.allowTrial ? 1 : 0,
    ].join(':')
    const cached = this.sourceCache.get(cacheKey)
    if (cached) throw new SourceUnavailableError(cached)

    const tried: { level: string; code?: number }[] = []
    let fee: number | undefined
    let trialUrl = ''
    let trialLevel = ''
    let requestError = ''

    for (const level of chain) {
      let data: any
      try {
        const result = await this.call<any>('song_url_v1', { id, level })
        data = result?.data?.[0]
      } catch (error) {
        requestError = apiErrorMessage(error)
        tried.push({ level })
        continue
      }
      const code = Number(data?.code)
      tried.push({ level, ...(Number.isFinite(code) ? { code } : {}) })
      if (Number.isFinite(Number(data?.fee))) fee = Number(data.fee)
      const url = typeof data?.url === 'string' ? data.url : ''
      // 试听片段以 freeTrialInfo 为准，无试听时接口返回 null 或字符串 'null'
      const trial = data?.freeTrialInfo != null && String(data.freeTrialInfo) !== 'null'
      if (url && !trial) {
        return {
          url,
          source: 'official',
          sourceName: 'netease',
          trial: false,
          quality: data?.level || level,
          requestedQuality: config.quality,
        }
      }
      if (url && trial && !trialUrl) {
        trialUrl = url
        trialLevel = data?.level || level
      }
    }

    if (config.unblock.enabled) {
      try {
        const source = config.unblock.source === 'auto' ? undefined : config.unblock.source
        const matched = await this.call<any>('song_url_match', {
          id,
          ...(source ? { source } : {}),
        })
        const matchedUrl = typeof matched?.data === 'string' ? matched.data : ''
        if (matchedUrl) {
          return {
            url: matched?.proxyUrl || matchedUrl,
            source: 'unblock',
            sourceName: source || 'auto',
            trial: false,
            quality: 'matched',
            requestedQuality: config.quality,
          }
        }
      } catch {
        // 解灰失败后继续判断是否允许试听。
      }
    }

    if (trialUrl && config.allowTrial) {
      return {
        url: trialUrl,
        source: 'trial',
        sourceName: 'netease',
        trial: true,
        quality: trialLevel,
        requestedQuality: config.quality,
      }
    }

    const failure = describeSourceFailure({
      fee,
      tried,
      requestError,
      trialOnly: Boolean(trialUrl),
    })
    if (failure.reason !== 'request_failed') this.sourceCache.set(cacheKey, failure, 10 * 60 * 1000)
    throw new SourceUnavailableError(failure)
  }

  async createQrLogin() {
    const keyResult = await this.call<any>('login_qr_key', { timestamp: Date.now() })
    const key = keyResult?.data?.unikey
    if (!key) throw new AppError('QR_LOGIN_FAILED', '未能获取二维码登录 key')
    const qr = await this.call<any>('login_qr_create', {
      key,
      qrimg: false,
      timestamp: Date.now(),
    })
    return { key: String(key), url: String(qr?.data?.qrurl || '') }
  }

  async checkQrLogin(key: string) {
    return this.call<any>('login_qr_check', { key, timestamp: Date.now() })
  }

  async validateCookie(cookie: string) {
    await this.initialize()
    try {
      const loginStatus = api.login_status
      if (typeof loginStatus !== 'function') {
        throw new AppError('API_NOT_FOUND', 'API 不支持 login_status')
      }
      const result = bodyOf<any>(await loginStatus({ cookie, timestamp: Date.now() }))
      const profile = result?.data?.profile || result?.profile
      const account = result?.data?.account || result?.account
      if (!profile?.userId) {
        throw new AppError('COOKIE_INVALID', 'Cookie 无效、已过期或账号未登录')
      }
      return {
        userId: Number(profile.userId),
        nickname: String(profile.nickname || ''),
        avatarUrl: profile.avatarUrl ? String(profile.avatarUrl) : undefined,
        vipType: Number(profile.vipType || account?.vipType || 0),
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(
        'COOKIE_VALIDATION_FAILED',
        '无法验证 Cookie 对应的网易云账号',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  loginStatus() {
    return this.call<any>('login_status', { timestamp: Date.now() })
  }

  async loginStatusSummary() {
    const result = await this.loginStatus()
    const profile = result?.data?.profile || result?.profile
    const account = result?.data?.account || result?.account
    if (!profile?.userId) return { loggedIn: false, valid: false }
    return {
      loggedIn: true,
      valid: true,
      profile: {
        userId: Number(profile.userId),
        nickname: String(profile.nickname || ''),
        avatarUrl: profile.avatarUrl ? String(profile.avatarUrl) : undefined,
        vipType: Number(profile.vipType || account?.vipType || 0),
      },
    }
  }

  private async currentUserId() {
    const status = await this.loginStatus()
    const uid = status?.data?.profile?.userId || status?.profile?.userId
    if (!uid) throw new AppError('AUTH_REQUIRED', '需要先登录网易云账号')
    return Number(uid)
  }

  async userProfile(uid?: number): Promise<UserProfile> {
    const userId = uid || (await this.currentUserId())
    const result = await this.call<any>('user_detail_new', {
      uid: userId,
      timestamp: Date.now(),
    }).catch(() => this.call<any>('user_detail', { uid: userId, timestamp: Date.now() }))
    const profile = result?.profile || result?.data?.profile
    if (!profile?.userId) throw new AppError('USER_NOT_FOUND', `未找到用户 ${userId}`)
    return {
      userId: Number(profile.userId),
      nickname: String(profile.nickname || '网易云用户'),
      avatar: profile.avatarUrl ? String(profile.avatarUrl) : undefined,
      signature: profile.signature ? String(profile.signature) : undefined,
      level: Number(result?.level || result?.data?.level || 0),
      vipType: Number(profile.vipType || 0),
      listenSongs: Number(result?.listenSongs || result?.data?.listenSongs || 0),
      follows: Number(profile.follows || 0),
      followeds: Number(profile.followeds || 0),
      playlistCount: Number(profile.playlistCount || 0),
      eventCount: Number(profile.eventCount || 0),
      createTime: Number(profile.createTime || 0) || undefined,
    }
  }

  logout() {
    return this.call<any>('logout', { timestamp: Date.now() })
  }

  async userPlaylists() {
    const uid = await this.currentUserId()
    const playlists: PlaylistSummary[] = []
    const limit = 100
    for (let offset = 0; ; offset += limit) {
      const result = await this.call<any>('user_playlist', { uid, limit, offset })
      const page = (result?.playlist || []).map(normalizePlaylist)
      playlists.push(...page)
      if (!result?.more || page.length < limit) break
    }
    return playlists
  }

  async playlistDetail(id: number) {
    const result = await this.call<any>('playlist_detail', { id, s: 0, timestamp: Date.now() })
    const playlist = result?.playlist
    if (!playlist?.id) throw new AppError('PLAYLIST_NOT_FOUND', `未找到歌单 ${id}`)
    return normalizePlaylist(playlist)
  }

  async playlistTracks(id: number) {
    const detail = await this.playlistDetail(id)
    const songs: Song[] = []
    const pageSize = 500
    for (let offset = 0; offset < 20_000; offset += pageSize) {
      const result = await this.call<any>('playlist_track_all', {
        id,
        limit: pageSize,
        offset,
        timestamp: Date.now(),
      })
      const page = (result?.songs || []).map(normalizeSong)
      songs.push(...page)
      if (page.length < pageSize) break
    }
    return { playlist: { ...detail, trackCount: songs.length }, songs }
  }

  async subscribePlaylist(id: number, subscribed: boolean) {
    const result = await this.call<any>('playlist_subscribe', {
      id,
      t: subscribed ? 1 : 2,
      timestamp: Date.now(),
    })
    if (result?.code !== undefined && Number(result.code) !== 200) {
      throw new AppError(
        'PLAYLIST_SUBSCRIBE_FAILED',
        `${subscribed ? '收藏' : '取消收藏'}歌单失败：${result?.message || result?.msg || result.code}`,
      )
    }
    return result
  }

  private ensureMutation(result: any, action: string) {
    const code = Number(result?.code ?? 200)
    if (code !== 200) {
      throw new AppError(
        'PLAYLIST_MUTATION_FAILED',
        `${action}失败：${result?.message || result?.msg || code}`,
        result,
      )
    }
    return result
  }

  async createPlaylist(name: string, privacy: 0 | 10 = 0) {
    const result = this.ensureMutation(
      await this.call<any>('playlist_create', { name, privacy, timestamp: Date.now() }),
      '创建歌单',
    )
    if (!result?.playlist?.id)
      throw new AppError('PLAYLIST_CREATE_FAILED', '创建歌单未返回歌单信息')
    return normalizePlaylist(result.playlist)
  }

  async renamePlaylist(id: number, name: string) {
    this.ensureMutation(
      await this.call<any>('playlist_name_update', { id, name, timestamp: Date.now() }),
      '重命名歌单',
    )
    return { id, name }
  }

  async deletePlaylist(id: number) {
    this.ensureMutation(
      await this.call<any>('playlist_delete', { id, timestamp: Date.now() }),
      '删除歌单',
    )
    return { id, deleted: true }
  }

  async updatePlaylistTracks(id: number, trackIds: number[], operation: 'add' | 'del') {
    if (!trackIds.length) throw new AppError('INVALID_ARGUMENT', '歌曲 ID 列表不能为空')
    const result = this.ensureMutation(
      await this.call<any>('playlist_tracks', {
        op: operation,
        pid: id,
        tracks: trackIds.join(','),
        timestamp: Date.now(),
      }),
      operation === 'add' ? '添加歌曲到歌单' : '从歌单移除歌曲',
    )
    return { id, trackIds, operation, count: Number(result?.count || trackIds.length) }
  }

  private async comments(
    method: 'comment_music' | 'comment_playlist',
    id: number,
    limit = 20,
    offset = 0,
  ): Promise<CommentPage> {
    const result = await this.call<any>(method, { id, limit, offset, timestamp: Date.now() })
    return {
      comments: (result?.comments || []).map(normalizeComment),
      hotComments: (result?.hotComments || []).map(normalizeComment),
      total: Number(result?.total || 0),
      more: Boolean(result?.more),
    }
  }

  songComments(id: number, limit = 20, offset = 0) {
    return this.comments('comment_music', id, limit, offset)
  }

  playlistComments(id: number, limit = 20, offset = 0) {
    return this.comments('comment_playlist', id, limit, offset)
  }

  async dailySongs() {
    const result = await this.call<any>('recommend_songs', { timestamp: Date.now() })
    return (result?.data?.dailySongs || []).map(normalizeSong)
  }

  async dailyPlaylists() {
    const result = await this.call<any>('recommend_resource', { timestamp: Date.now() })
    return (result?.recommend || []).map(normalizePlaylist)
  }

  async personalizedPlaylists(limit = 30) {
    const result = await this.call<any>('personalized', { limit, timestamp: Date.now() })
    return (result?.result || []).map(normalizePlaylist)
  }

  async discoverPlaylists(cat = '全部', order: 'hot' | 'new' = 'hot', limit = 50, offset = 0) {
    const result = await this.call<any>('top_playlist', {
      cat,
      order,
      limit,
      offset,
      timestamp: Date.now(),
    })
    return {
      playlists: (result?.playlists || []).map(normalizePlaylist),
      total: Number(result?.total || 0),
      more: Boolean(result?.more),
      cat,
      order,
    }
  }

  async highqualityPlaylists(cat = '全部', limit = 50, before = 0) {
    const result = await this.call<any>('top_playlist_highquality', {
      cat,
      limit,
      before,
      timestamp: Date.now(),
    })
    return {
      playlists: (result?.playlists || []).map(normalizePlaylist),
      total: Number(result?.total || 0),
      more: Boolean(result?.more),
      lasttime: Number(result?.lasttime || 0),
      cat,
    }
  }

  async toplists() {
    const result = await this.call<any>('toplist', { timestamp: Date.now() })
    return (result?.list || []).map(normalizePlaylist)
  }

  async toplist(id: number) {
    const result = await this.call<any>('top_list', { id, timestamp: Date.now() })
    const playlist = result?.playlist
    if (!playlist?.id) throw new AppError('TOPLIST_NOT_FOUND', `未找到榜单 ${id}`)
    const songs = (playlist?.tracks || []).map(normalizeSong)
    return { playlist: { ...normalizePlaylist(playlist), trackCount: songs.length }, songs }
  }

  async newSongs(area: NewSongArea = 0) {
    if (!(area in newSongAreaNames)) {
      throw new AppError('INVALID_ARGUMENT', '新歌地区必须是 0、7、96、8 或 16')
    }
    const result = await this.call<any>('top_song', { type: area, timestamp: Date.now() })
    return { area, name: newSongAreaNames[area], songs: (result?.data || []).map(normalizeSong) }
  }

  async heartMode(seedId: number) {
    const playlists = await this.userPlaylists()
    const likedPlaylist =
      playlists.find((playlist) => playlist.specialType === 5) ||
      playlists.find((playlist) => playlist.name === '我喜欢的音乐')
    if (!likedPlaylist) {
      throw new AppError('LIKED_PLAYLIST_NOT_FOUND', '没有找到账号的“我喜欢的音乐”歌单')
    }
    const result = await this.call<any>('playmode_intelligence_list', {
      id: seedId,
      pid: likedPlaylist.id,
      sid: seedId,
      count: 1,
      timestamp: Date.now(),
    })
    const songs = (result?.data || [])
      .map((item: any) => item?.songInfo || item?.song || item)
      .filter((item: any) => item?.id)
      .map(normalizeSong)
    if (!songs.length) throw new AppError('HEART_MODE_EMPTY', '心动模式没有返回可播放歌曲')
    return { seedId, playlist: likedPlaylist, songs }
  }

  async personalFm() {
    const result = await this.call<any>('personal_fm', { timestamp: Date.now() })
    return (result?.data || []).map(normalizeSong)
  }

  fmTrash(id: number) {
    return this.call<any>('fm_trash', { id, timestamp: Date.now() })
  }

  async likedSongIds() {
    const uid = await this.currentUserId()
    const result = await this.call<any>('likelist', { uid, timestamp: Date.now() })
    return (result?.ids || []).map(Number).filter(Number.isFinite)
  }

  async cloudSongs(): Promise<CloudLibrary> {
    const songs: Song[] = []
    const limit = 200
    let count = 0
    let size = 0
    let maxSize = 0
    for (let offset = 0; ; offset += limit) {
      const result = await this.call<any>('user_cloud', {
        limit,
        offset,
        timestamp: Date.now(),
      })
      const page = (result?.data || [])
        .map((item: any) => item?.simpleSong || item?.song || item)
        .filter((item: any) => item?.id)
        .map(normalizeSong)
      songs.push(...page)
      count = Number(result?.count || songs.length)
      size = Number(result?.size || 0)
      maxSize = Number(result?.maxSize || 0)
      if (!result?.hasMore || page.length < limit) break
    }
    return { songs, count: Math.max(count, songs.length), size, maxSize }
  }

  async subscribedAlbums(): Promise<CollectionSummary[]> {
    const albums: CollectionSummary[] = []
    const limit = 100
    for (let offset = 0; ; offset += limit) {
      const result = await this.call<any>('album_sublist', { limit, offset, timestamp: Date.now() })
      const page = (result?.data || []).map((album: any) => ({
        id: Number(album?.id),
        name: String(album?.name || '未知专辑'),
        type: 'album' as const,
        cover: album?.picUrl,
        subtitle: (album?.artists || [])
          .map((artist: any) => artist?.name)
          .filter(Boolean)
          .join(' / '),
        count: Number(album?.size || 0),
      }))
      albums.push(...page)
      if (!result?.hasMore || page.length < limit) break
    }
    return albums
  }

  async albumSongs(id: number) {
    const result = await this.call<any>('album', { id, timestamp: Date.now() })
    const album = result?.album
    return {
      collection: {
        id,
        name: String(album?.name || '未知专辑'),
        type: 'album' as const,
        cover: album?.picUrl,
        subtitle: (album?.artists || [])
          .map((artist: any) => artist?.name)
          .filter(Boolean)
          .join(' / '),
        count: Number(result?.songs?.length || album?.size || 0),
      },
      songs: (result?.songs || []).map(normalizeSong),
    }
  }

  async subscribedArtists(): Promise<CollectionSummary[]> {
    const artists: CollectionSummary[] = []
    const limit = 100
    for (let offset = 0; ; offset += limit) {
      const result = await this.call<any>('artist_sublist', {
        limit,
        offset,
        timestamp: Date.now(),
      })
      const page = (result?.data || []).map((artist: any) => ({
        id: Number(artist?.id),
        name: String(artist?.name || '未知歌手'),
        type: 'artist' as const,
        cover: artist?.picUrl || artist?.img1v1Url,
        subtitle: artist?.alias?.length ? artist.alias.join(' / ') : undefined,
        count: Number(artist?.musicSize || 0),
      }))
      artists.push(...page)
      if (!result?.hasMore || page.length < limit) break
    }
    return artists
  }

  async artistSongs(id: number) {
    const songs: Song[] = []
    const limit = 100
    const detail = await this.call<any>('artist_detail', { id, timestamp: Date.now() }).catch(
      () => undefined,
    )
    let artist: any = detail?.data?.artist || detail?.artist
    for (let offset = 0; ; offset += limit) {
      const result = await this.call<any>('artist_songs', {
        id,
        limit,
        offset,
        order: 'hot',
        timestamp: Date.now(),
      })
      artist ||= result?.artist
      const page = (result?.songs || []).map(normalizeSong)
      songs.push(...page)
      if (!result?.more || page.length < limit) break
    }
    return {
      collection: {
        id,
        name: String(artist?.name || '未知歌手'),
        type: 'artist' as const,
        cover: artist?.picUrl || artist?.img1v1Url,
        subtitle: artist?.alias?.length ? artist.alias.join(' / ') : undefined,
        count: songs.length,
      },
      songs,
    }
  }

  async listeningRecord(range: 'week' | 'all'): Promise<ListeningRecordEntry[]> {
    const uid = await this.currentUserId()
    const result = await this.call<any>('user_record', {
      uid,
      type: range === 'week' ? 1 : 0,
      timestamp: Date.now(),
    })
    const rows = range === 'week' ? result?.weekData || [] : result?.allData || []
    return rows.map((item: any) => ({
      song: normalizeSong(item?.song),
      playCount: Number(item?.playCount || 0),
      score: Number(item?.score || 0),
    }))
  }

  /** 听歌足迹：累计听歌时长（秒）+ 周/月/年报告 */
  async listenStats(type: ListenReport['type']): Promise<ListenStats> {
    const [total, report] = await Promise.all([
      this.call<any>('listen_data_total', { timestamp: Date.now() }),
      this.call<any>('listen_data_report', { type, timestamp: Date.now() }),
    ])
    const data = report?.data || {}
    // listenTimeDistributionBlock.playDuration 含播客时长，纯音乐时长在 listenTimeBlock
    return {
      totalPlaySeconds: Number(total?.data?.totalDuration || 0),
      report: {
        type,
        startTime: Number(data.startTime || 0),
        endTime: Number(data.endTime || 0),
        playMinutes: Number(data.listenTimeBlock?.playDuration || 0),
        listenDays: Number(data.listenTimeDistributionBlock?.listenDays || 0),
        songCount: Number(data.wallpaperBlock?.songCount || 0),
        dailyDurations: (data.listenTimeDistributionBlock?.durationDetails || []).map(
          (item: any) => ({
            date: String(item?.period || ''),
            minutes: Number(item?.duration || 0),
          }),
        ),
        topSongs: (data.topSongBlock?.sections || []).map((item: any) => ({
          id: Number(item?.songId || 0),
          name: String(item?.songName || '未知歌曲'),
          text: item?.text ? String(item.text) : undefined,
        })),
        topArtists: (data.topArtistBlock?.sections || []).map((item: any) => ({
          id: Number(item?.artistId || 0),
          name: String(item?.artistName || '未知歌手'),
          text: item?.text ? String(item.text) : undefined,
        })),
        styles: (data.topStyleBlock?.sections || []).map((item: any) => ({
          name: String(item?.genreName || '未知'),
          percent: Number(item?.percent || 0),
        })),
        languages: (data.topLanguageBlock?.sections || []).map((item: any) => ({
          language: String(item?.language || '未知'),
          percent: Number(item?.percent || 0),
          songCount: Number(item?.playSongNum || 0),
        })),
        ages: (data.topAgeBlock?.sections || []).map((item: any) => ({
          age: String(item?.age || ''),
          songCount: Number(item?.playSongNum || 0),
        })),
      },
    }
  }

  /** 今日听歌排行（按最近播放排序） */
  async todayListenSongs(): Promise<TodayListenSong[]> {
    const result = await this.call<any>('listen_data_today_song', { timestamp: Date.now() })
    return (result?.data?.songDTOs || []).map((item: any) => ({
      id: Number(item?.songId || 0),
      name: String(item?.songName || '未知歌曲'),
      artists: (item?.artists || [])
        .map((artist: any) => String(artist?.artistName || ''))
        .filter(Boolean),
      lastPlayTime: Number(item?.lastPlayTime || 0) * 1000,
    }))
  }

  /** 服务端最近播放（跨设备），playTime 为毫秒时间戳 */
  async recentSongs(limit = 50): Promise<RecentPlayEntry[]> {
    const result = await this.call<any>('record_recent_song', { limit, timestamp: Date.now() })
    return (result?.data?.list || [])
      .map((item: any): RecentPlayEntry | undefined => {
        const id = Number(item?.data?.id)
        if (!item?.data || !Number.isInteger(id) || id <= 0) return undefined
        return {
          song: normalizeSong(item.data),
          playTime: Number(item?.playTime || 0),
          ...(item?.multiTerminalInfo?.os ? { os: String(item.multiTerminalInfo.os) } : {}),
        }
      })
      .filter((entry: RecentPlayEntry | undefined): entry is RecentPlayEntry => Boolean(entry))
  }

  /** 最近播放的歌单 / 专辑 / 播客：接口与歌曲共用同一层包装 */
  private async recentResources(
    name: 'record_recent_playlist' | 'record_recent_album' | 'record_recent_dj',
    limit: number,
  ): Promise<RecentResourceEntry[]> {
    const result = await this.call<any>(name, { limit, timestamp: Date.now() })
    return (result?.data?.list || [])
      .map((item: any): RecentResourceEntry | undefined => {
        const detail = item?.data
        const id = Number(detail?.id)
        // Number(null) 也是 0，这里要求正的整数 ID 才算有效条目
        if (!detail || !Number.isInteger(id) || id <= 0) return undefined
        const count = Number(detail?.size ?? detail?.programCount)
        const cover = detail?.coverImgUrl || detail?.picUrl
        return {
          id,
          name: String(detail.name || '未命名'),
          ...(cover ? { cover: String(cover) } : {}),
          playTime: Number(item?.playTime || 0),
          ...(Number.isFinite(count) && count > 0 ? { count } : {}),
        }
      })
      .filter((entry: RecentResourceEntry | undefined): entry is RecentResourceEntry =>
        Boolean(entry),
      )
  }

  recentPlaylists(limit = 50) {
    return this.recentResources('record_recent_playlist', limit)
  }

  recentAlbums(limit = 50) {
    return this.recentResources('record_recent_album', limit)
  }

  recentRadios(limit = 50) {
    return this.recentResources('record_recent_dj', limit)
  }

  /**
   * 每日签到（积分）+ 云贝签到。
   * daily_signin 真正成功时只返回 { code, point }，接口被服务端关闭时返回 { code:200, msg:'功能暂不支持' }；
   * yunbei_sign 的结果在 data.sign / data.yunbeiNum。两者都按这些字段判定，不再无条件报成功。
   */
  async signin(): Promise<SigninResult> {
    const rejectMessage = (error: unknown) => {
      const detail = error instanceof AppError ? (error.details as any) : undefined
      return { code: Number(detail?.code), message: apiErrorMessage(error) }
    }
    const daily = await (async (): Promise<SigninTaskResult> => {
      const task = '每日签到'
      try {
        const result = await this.call<any>('daily_signin', { type: 0, timestamp: Date.now() })
        const code = Number(result?.code)
        const message = String(result?.msg || result?.message || '').trim()
        const point = Number(result?.point)
        if (code !== 200) {
          return {
            task,
            success: false,
            repeated: false,
            message: message || `接口返回错误码 ${Number.isFinite(code) ? code : '未知'}`,
          }
        }
        // 带 msg 的 200 说明这次签到并未真正完成（如「功能暂不支持」）
        if (message) return { task, success: false, repeated: false, message }
        return {
          task,
          success: true,
          repeated: false,
          message: '签到成功',
          point: Number.isFinite(point) ? point : undefined,
        }
      } catch (error) {
        const { code, message } = rejectMessage(error)
        if (code === -2 || /重复|已签到|已经签/.test(message)) {
          return { task, success: true, repeated: true, message: '今天已签到' }
        }
        return { task, success: false, repeated: false, message }
      }
    })()
    const yunbei = await (async (): Promise<SigninTaskResult> => {
      const task = '云贝签到'
      try {
        const result = await this.call<any>('yunbei_sign', { timestamp: Date.now() })
        const code = Number(result?.code)
        const message = String(result?.message || result?.msg || '').trim()
        if (code !== 200) {
          return {
            task,
            success: false,
            repeated: false,
            message: message || `接口返回错误码 ${Number.isFinite(code) ? code : '未知'}`,
          }
        }
        const signed = result?.data?.sign
        if (signed === true) {
          const yunbeiNum = Number(result?.data?.yunbeiNum)
          return {
            task,
            success: true,
            repeated: false,
            message: '签到成功',
            point: Number.isFinite(yunbeiNum) ? yunbeiNum : undefined,
          }
        }
        return {
          task,
          success: false,
          repeated: false,
          message: message || '本次未获得云贝（可能今天已签到）',
        }
      } catch (error) {
        const { code, message } = rejectMessage(error)
        if (code === -2 || /重复|已签到|已经签/.test(message)) {
          return { task, success: true, repeated: true, message: '今天已签到' }
        }
        return { task, success: false, repeated: false, message }
      }
    })()
    return { daily, yunbei }
  }

  /** 签到概况：今日是否已签、近 30 天记录、累计/周期签到进度，以及会员成长值与云贝余额 */
  async signinOverview(): Promise<SigninOverview> {
    const [progress, growth, account] = await Promise.all([
      this.call<any>('signin_progress', { timestamp: Date.now() }).catch(() => undefined),
      this.call<any>('vip_growthpoint', { timestamp: Date.now() }).catch(() => undefined),
      this.call<any>('yunbei_info', { timestamp: Date.now() }).catch(() => undefined),
    ])
    const data = progress?.data || {}
    const userLevel = growth?.data?.userLevel
    const balance = Number(account?.userPoint?.balance)
    return {
      todaySignedIn: data.today?.todaySignedIn === true,
      records: (data.records || [])
        .map((item: any) => ({ day: String(item?.day || ''), signed: item?.signed === true }))
        .filter((item: { day: string }) => item.day),
      progress: (data.stats || []).map((item: any) => ({
        id: Number(item?.id || 0),
        description: String(item?.description || ''),
        currentProgress: Number(item?.currentProgress || 0),
        maxProgressReached: Number(item?.maxProgressReached || 0),
        ...(item?.repeatType ? { repeatType: String(item.repeatType) } : {}),
        ...(item?.calcType ? { calcType: String(item.calcType) } : {}),
      })),
      ...(userLevel
        ? {
            growth: {
              level: Number(userLevel.level || 0),
              ...(userLevel.levelName ? { levelName: String(userLevel.levelName) } : {}),
              growthPoint: Number(userLevel.growthPoint || 0),
              maxLevel: userLevel.maxLevel === true,
            },
          }
        : {}),
      ...(Number.isFinite(balance)
        ? { yunbei: { level: Number(account?.level || 0), balance } }
        : {}),
    }
  }

  like(id: number, liked: boolean) {
    return this.call<any>('like', { id, like: liked, timestamp: Date.now() })
  }

  async scrobble(
    song: Song,
    playedSeconds: number,
    context: QueueContext | undefined,
    mode: ScrobbleMode,
    level: string,
  ) {
    const fn = mode === 'ncbl' && typeof api.scrobble_v1 === 'function' ? 'scrobble_v1' : 'scrobble'
    const sourceId = context?.id || song.album.id || song.id
    const result = await this.call<any>(fn, {
      id: song.id,
      sourceid: sourceId,
      source: context?.type || 'list',
      time: Math.max(1, Math.floor(playedSeconds)),
      total: Math.max(1, Math.floor(song.duration / 1000)),
      name: song.name,
      artist: song.artists.map((artist) => artist.name).join(' / '),
      bitrate: level === 'lossless' || level === 'hires' ? 999 : level === 'exhigh' ? 320 : 192,
      level,
      vip: song.fee === 1,
    })
    if (result?.code !== 200 && result?.data !== 'success') {
      throw new AppError(
        'SCROBBLE_FAILED',
        `${fn} 上报失败：${result?.msg || result?.message || result?.code || '未知错误'}`,
        result,
      )
    }
    return { mode: (fn === 'scrobble_v1' ? 'ncbl' : 'legacy') as ScrobbleMode, result }
  }
}
