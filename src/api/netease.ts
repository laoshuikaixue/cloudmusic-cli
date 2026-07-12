import { createRequire } from 'node:module'
import { AppError } from '../core/errors.js'
import { mergeLyrics } from '../core/lyrics.js'
import type {
  AppConfig,
  CloudLibrary,
  CollectionSummary,
  ListeningRecordEntry,
  LyricLine,
  CommentPage,
  MusicComment,
  NewSongArea,
  PlaylistSummary,
  QueueContext,
  ScrobbleMode,
  Song,
  SourceResult,
} from '../core/types.js'

const require = createRequire(import.meta.url)
process.env.DOTENV_CONFIG_QUIET ??= 'true'
const api = require('@neteasecloudmusicapienhanced/api') as Record<
  string,
  (params?: Record<string, unknown>) => Promise<any>
>

let initializePromise: Promise<void> | undefined

const bodyOf = <T = any>(response: any): T => (response?.body ?? response) as T

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
      return bodyOf<T>(await fn({ ...params, ...(cookie ? { cookie } : {}) }))
    } catch (error: any) {
      const message = error?.body?.message || error?.body?.msg || error?.message || String(error)
      throw new AppError('API_REQUEST_FAILED', `${name} 请求失败：${message}`, error?.body)
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

  async songDetail(id: number) {
    const result = await this.call<any>('song_detail', { ids: String(id) })
    const raw = result?.songs?.[0]
    if (!raw) throw new AppError('SONG_NOT_FOUND', `未找到歌曲 ${id}`)
    return normalizeSong(raw)
  }

  async lyrics(id: number): Promise<{ lines: LyricLine[]; raw: any }> {
    const raw = await this.call<any>('lyric_new', { id })
    return { lines: mergeLyrics(raw), raw }
  }

  async resolveSource(id: number, config: AppConfig): Promise<SourceResult> {
    const official = await this.call<any>('song_url_v1', { id, level: config.quality })
    const data = official?.data?.[0]
    const hasUrl = typeof data?.url === 'string' && data.url.length > 0
    const isTrial = data?.freeTrialInfo != null
    if (hasUrl && !isTrial) {
      return {
        url: data.url,
        source: 'official',
        sourceName: 'netease',
        trial: false,
        quality: data?.level || data?.type || config.quality,
      }
    }

    if (config.unblock.enabled) {
      try {
        const source = config.unblock.source === 'auto' ? undefined : config.unblock.source
        const matched = await this.call<any>('song_url_match', {
          id,
          ...(source ? { source } : {}),
        })
        const matchedUrl =
          typeof matched?.data === 'string' ? matched.data : matched?.data?.url || matched?.url
        if (matchedUrl) {
          return {
            url: matched?.proxyUrl || matchedUrl,
            source: 'unblock',
            sourceName: source || 'auto',
            trial: false,
            quality: 'matched',
          }
        }
      } catch {
        // 解灰失败后继续判断是否允许试听。
      }
    }

    if (hasUrl && isTrial && config.allowTrial) {
      return {
        url: data.url,
        source: 'trial',
        sourceName: 'netease',
        trial: true,
        quality: data?.level || data?.type || config.quality,
      }
    }
    throw new AppError(
      isTrial ? 'TRIAL_DISABLED' : 'NO_PLAYABLE_SOURCE',
      isTrial ? '歌曲仅提供试听，当前未允许播放试听片段' : '没有找到可播放的音源',
    )
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
