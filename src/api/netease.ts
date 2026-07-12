import { createRequire } from 'node:module'
import { AppError } from '../core/errors.js'
import { mergeLyrics } from '../core/lyrics.js'
import type { AppConfig, LyricLine, Song, SourceResult } from '../core/types.js'

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

  logout() {
    return this.call<any>('logout', { timestamp: Date.now() })
  }

  async userPlaylists() {
    const status = await this.loginStatus()
    const uid = status?.data?.profile?.userId || status?.profile?.userId
    if (!uid) throw new AppError('AUTH_REQUIRED', '需要先登录网易云账号')
    const result = await this.call<any>('user_playlist', { uid, limit: 100, offset: 0 })
    return result?.playlist || []
  }

  async dailySongs() {
    const result = await this.call<any>('recommend_songs', { timestamp: Date.now() })
    return (result?.data?.dailySongs || []).map(normalizeSong)
  }

  async personalFm() {
    const result = await this.call<any>('personal_fm', { timestamp: Date.now() })
    return (result?.data || []).map(normalizeSong)
  }

  like(id: number, liked: boolean) {
    return this.call<any>('like', { id, like: liked, timestamp: Date.now() })
  }

  async scrobble(id: number, time: number) {
    const fn = typeof api.scrobble_v1 === 'function' ? 'scrobble_v1' : 'scrobble'
    return this.call<any>(fn, { id, sourceid: 0, time: Math.floor(time) })
  }
}
