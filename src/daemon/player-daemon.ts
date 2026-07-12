import { spawnSync } from 'node:child_process'
import { AudioPipeline } from '../audio/pipeline.js'
import { NeteaseApi } from '../api/netease.js'
import { AppError } from '../core/errors.js'
import { normalizeNeteaseCookie } from '../core/cookie.js'
import { findLyricIndex } from '../core/lyrics.js'
import { AppStore } from '../core/store.js'
import { SmtcBridge, type SmtcEvent } from '../system/smtc.js'
import type {
  AppConfig,
  LyricLine,
  PlaybackStatus,
  QueueSnapshot,
  Song,
  SourceResult,
} from '../core/types.js'

const numberParam = (value: unknown, name: string) => {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new AppError('INVALID_ARGUMENT', `${name} 必须是数字`)
  return number
}

const stringParam = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('INVALID_ARGUMENT', `${name} 不能为空`)
  }
  return value.trim()
}

export class PlayerDaemon {
  private readonly store = new AppStore()
  private readonly api = new NeteaseApi(() => this.store.getCookie())
  private readonly pipeline = new AudioPipeline()
  private queue: QueueSnapshot = { songs: [], index: -1 }
  private config!: AppConfig
  private state: PlaybackStatus['state'] = 'idle'
  private source: SourceResult | null = null
  private currentUrl = ''
  private sourceResolvedAt = 0
  private lyrics: LyricLine[] = []
  private error?: string
  private cycle = 0
  private scrobbledCycle = -1
  private scrobbleTimer?: NodeJS.Timeout
  private smtcTimer?: NodeJS.Timeout
  private readonly smtc = new SmtcBridge()

  private handleSmtcEvent(event: SmtcEvent) {
    let operation: Promise<unknown> | undefined
    if (event.event === 'play') operation = this.resume()
    if (event.event === 'pause') operation = this.pause()
    if (event.event === 'stop') operation = this.stop()
    if (event.event === 'next') operation = this.next()
    if (event.event === 'previous') operation = this.previous()
    if (event.event === 'seek') operation = this.seek(event.positionMs / 1000)
    void operation?.catch((error) => {
      this.error = error instanceof Error ? error.message : String(error)
    })
  }

  async initialize() {
    await this.store.load()
    this.config = this.store.getConfig()
    this.queue = await this.store.loadSession()
    if (this.queue.index >= this.queue.songs.length) this.queue.index = this.queue.songs.length - 1
    this.pipeline.on('ended', () => void this.onEnded())
    this.pipeline.on('error', (error: Error) => {
      this.state = 'error'
      this.error = error.message
    })
    this.scrobbleTimer = setInterval(() => void this.maybeScrobble(), 1000)
    if (this.config.smtc.enabled) {
      await this.smtc.start((event) => this.handleSmtcEvent(event))
    }
    this.smtcTimer = setInterval(() => void this.smtc.sync(this.status()), 1000)
  }

  private get song() {
    return this.queue.songs[this.queue.index] || null
  }

  private async persistQueue() {
    await this.store.saveSession(this.queue)
  }

  private async startSong(song: Song, offset = 0) {
    this.state = 'loading'
    this.error = undefined
    this.cycle += 1
    const [source, lyricResult] = await Promise.all([
      this.api.resolveSource(song.id, this.config),
      this.api.lyrics(song.id).catch(() => ({ lines: [], raw: null })),
    ])
    this.source = source
    this.currentUrl = source.url
    this.sourceResolvedAt = Date.now()
    this.lyrics = lyricResult.lines
    await this.pipeline.start(source.url, {
      mpvPath: this.config.binaries.mpv || 'mpv',
      ffmpegPath: this.config.binaries.ffmpeg || 'ffmpeg',
      volume: this.config.volume,
      offset,
    })
    this.state = 'playing'
    void this.smtc.sync(this.status())
  }

  async playSong(id: number) {
    const existing = this.queue.songs.findIndex((song) => song.id === id)
    if (existing >= 0) {
      this.queue.index = existing
    } else {
      this.queue.songs.push(await this.api.songDetail(id))
      this.queue.index = this.queue.songs.length - 1
    }
    await this.persistQueue()
    await this.startSong(this.song as Song)
    return this.status()
  }

  private async onEnded() {
    if (this.state === 'stopped' || this.state === 'idle') return
    await this.next().catch((error) => {
      this.state = 'error'
      this.error = error instanceof Error ? error.message : String(error)
    })
  }

  async pause() {
    if (this.state !== 'playing') return this.status()
    await this.pipeline.pause()
    this.state = 'paused'
    void this.smtc.sync(this.status())
    return this.status()
  }

  async resume() {
    if (this.state !== 'paused') return this.status()
    await this.pipeline.resume()
    this.state = 'playing'
    void this.smtc.sync(this.status())
    return this.status()
  }

  async toggle() {
    return this.state === 'playing' ? this.pause() : this.resume()
  }

  async stop() {
    await this.pipeline.stop()
    this.state = 'stopped'
    void this.smtc.sync(this.status())
    return this.status()
  }

  async seek(target: number, relative = false) {
    const song = this.song
    if (!song) throw new AppError('NOT_PLAYING', '当前没有歌曲')
    const current = this.pipeline.getPosition()
    const duration = song.duration / 1000
    const position = Math.max(
      0,
      Math.min(duration || Infinity, relative ? current + target : target),
    )
    if (!this.currentUrl || Date.now() - this.sourceResolvedAt > 8 * 60 * 1000) {
      this.source = await this.api.resolveSource(song.id, this.config)
      this.currentUrl = this.source.url
      this.sourceResolvedAt = Date.now()
    }
    const wasPaused = this.state === 'paused'
    this.state = 'loading'
    await this.pipeline.start(this.currentUrl, {
      mpvPath: this.config.binaries.mpv || 'mpv',
      ffmpegPath: this.config.binaries.ffmpeg || 'ffmpeg',
      volume: this.config.volume,
      offset: position,
    })
    this.state = 'playing'
    if (wasPaused) await this.pause()
    return this.status()
  }

  async volume(value: number) {
    const volume = Math.max(0, Math.min(100, value))
    this.config = await this.store.updateConfig({ volume })
    await this.pipeline.setVolume(volume).catch(() => undefined)
    return this.status()
  }

  async next() {
    if (!this.queue.songs.length) throw new AppError('QUEUE_EMPTY', '播放队列为空')
    if (this.config.mode === 'shuffle' && this.queue.songs.length > 1) {
      let nextIndex = this.queue.index
      while (nextIndex === this.queue.index)
        nextIndex = Math.floor(Math.random() * this.queue.songs.length)
      this.queue.index = nextIndex
    } else if (this.config.mode !== 'repeat-one') {
      this.queue.index = (this.queue.index + 1) % this.queue.songs.length
    }
    await this.persistQueue()
    await this.startSong(this.song as Song)
    return this.status()
  }

  async previous() {
    if (!this.queue.songs.length) throw new AppError('QUEUE_EMPTY', '播放队列为空')
    this.queue.index = (this.queue.index - 1 + this.queue.songs.length) % this.queue.songs.length
    await this.persistQueue()
    await this.startSong(this.song as Song)
    return this.status()
  }

  status(): PlaybackStatus {
    const position = this.pipeline.getPosition()
    const lyricIndex = findLyricIndex(this.lyrics, position)
    return {
      daemon: 'running',
      state: this.state,
      song: this.song,
      position,
      duration: (this.song?.duration || 0) / 1000,
      volume: this.config.volume,
      mode: this.config.mode,
      source: this.source?.source || null,
      sourceName: this.source?.sourceName,
      trial: this.source?.trial || false,
      quality: this.source?.quality,
      queueLength: this.queue.songs.length,
      queueIndex: this.queue.index,
      currentLyric: this.lyrics[lyricIndex]?.text,
      nextLyric: this.lyrics[lyricIndex + 1]?.text,
      error: this.error,
    }
  }

  private async maybeScrobble() {
    const song = this.song
    if (!this.config.scrobble.enabled || !song || !this.store.getCookie()) return
    if (this.scrobbledCycle === this.cycle) return
    const duration = song.duration / 1000
    if (duration <= 30) return
    const threshold = Math.min(duration / 2, 240)
    const position = this.pipeline.getPosition()
    if (position < threshold) return
    this.scrobbledCycle = this.cycle
    await this.api.scrobble(song.id, position).catch(() => {
      this.scrobbledCycle = -1
    })
  }

  async shutdown() {
    if (this.scrobbleTimer) clearInterval(this.scrobbleTimer)
    if (this.smtcTimer) clearInterval(this.smtcTimer)
    this.smtc.stop()
    await this.pipeline.stop()
  }

  async dispatch(method: string, params: Record<string, unknown> = {}) {
    switch (method) {
      case 'ping':
        return { pid: process.pid, version: '0.1.0' }
      case 'status':
        return this.status()
      case 'search':
        return this.api.search(
          stringParam(params.keywords, 'keywords'),
          Number(params.limit || 20),
          Number(params.offset || 0),
        )
      case 'play':
        return this.playSong(numberParam(params.id, 'id'))
      case 'pause':
        return this.pause()
      case 'resume':
        return this.resume()
      case 'toggle':
        return this.toggle()
      case 'stop':
        return this.stop()
      case 'next':
        return this.next()
      case 'previous':
        return this.previous()
      case 'seek':
        return this.seek(numberParam(params.value, 'value'), Boolean(params.relative))
      case 'volume':
        return this.volume(numberParam(params.value, 'value'))
      case 'spectrum':
        return this.pipeline.getSpectrum()
      case 'lyrics': {
        const id = params.id ? numberParam(params.id, 'id') : this.song?.id
        if (!id) throw new AppError('NOT_PLAYING', '当前没有歌曲')
        return this.api.lyrics(id)
      }
      case 'queue.list':
        return this.queue
      case 'queue.add': {
        const song = await this.api.songDetail(numberParam(params.id, 'id'))
        this.queue.songs.push(song)
        if (this.queue.index < 0) this.queue.index = 0
        await this.persistQueue()
        return this.queue
      }
      case 'queue.remove': {
        const index = numberParam(params.index, 'index')
        if (index < 0 || index >= this.queue.songs.length) {
          throw new AppError('INVALID_ARGUMENT', '队列索引超出范围')
        }
        this.queue.songs.splice(index, 1)
        if (!this.queue.songs.length) this.queue.index = -1
        else if (this.queue.index >= this.queue.songs.length)
          this.queue.index = this.queue.songs.length - 1
        await this.persistQueue()
        return this.queue
      }
      case 'queue.move': {
        const from = numberParam(params.from, 'from')
        const to = numberParam(params.to, 'to')
        if (
          from < 0 ||
          to < 0 ||
          from >= this.queue.songs.length ||
          to >= this.queue.songs.length
        ) {
          throw new AppError('INVALID_ARGUMENT', '队列索引超出范围')
        }
        const [song] = this.queue.songs.splice(from, 1)
        if (song) this.queue.songs.splice(to, 0, song)
        if (this.queue.index === from) this.queue.index = to
        await this.persistQueue()
        return this.queue
      }
      case 'queue.clear':
        await this.stop()
        this.queue = { songs: [], index: -1 }
        await this.persistQueue()
        return this.queue
      case 'login.qr.start':
        return this.api.createQrLogin()
      case 'login.qr.check': {
        const result = await this.api.checkQrLogin(stringParam(params.key, 'key'))
        if (result?.code === 803 && result?.cookie) {
          const cookie = normalizeNeteaseCookie(result.cookie)
          const profile = await this.api.validateCookie(cookie)
          await this.store.setCookie(cookie)
          return {
            code: result.code,
            message: result.message,
            loggedIn: true,
            persisted: true,
            profile,
          }
        }
        return { code: result?.code, message: result?.message, loggedIn: false }
      }
      case 'login.cookie': {
        const cookie = normalizeNeteaseCookie(stringParam(params.cookie, 'cookie'))
        const profile = await this.api.validateCookie(cookie)
        await this.store.setCookie(cookie)
        return { loggedIn: true, valid: true, persisted: true, profile }
      }
      case 'login.status':
        return this.api.loginStatusSummary()
      case 'logout':
        await this.api.logout().catch(() => undefined)
        await this.store.clearCookie()
        return { loggedIn: false }
      case 'library.playlists':
        return this.api.userPlaylists()
      case 'library.daily':
        return this.api.dailySongs()
      case 'library.fm':
        return this.api.personalFm()
      case 'like':
        return this.api.like(numberParam(params.id, 'id'), params.liked !== false)
      case 'source.status':
        return {
          config: this.config.unblock,
          current: this.source && { ...this.source, url: undefined },
        }
      case 'source.set':
        this.config = await this.store.updateConfig({
          unblock: {
            enabled:
              params.enabled === undefined ? this.config.unblock.enabled : Boolean(params.enabled),
            source: typeof params.source === 'string' ? params.source : this.config.unblock.source,
          },
        })
        return this.config.unblock
      case 'source.test': {
        const source = await this.api.resolveSource(numberParam(params.id, 'id'), this.config)
        return { ...source, url: undefined, playable: true }
      }
      case 'smtc.status':
        return this.smtc.status()
      case 'smtc.set': {
        const enabled = Boolean(params.enabled)
        this.config = await this.store.updateConfig({ smtc: { enabled } })
        if (enabled) {
          await this.smtc.start((event) => this.handleSmtcEvent(event))
        } else {
          this.smtc.stop()
        }
        return this.smtc.status()
      }
      case 'config.get':
        return this.store.getConfig()
      case 'config.set': {
        const patch = params.patch as Partial<AppConfig>
        this.config = await this.store.updateConfig(patch || {})
        return this.config
      }
      case 'doctor':
        return this.doctor()
      case 'shutdown':
        return { shuttingDown: true }
      default:
        throw new AppError('METHOD_NOT_FOUND', `未知命令：${method}`)
    }
  }

  private async doctor() {
    const inspect = (command: string, versionArgument: string) => {
      const result = spawnSync(command, [versionArgument], { encoding: 'utf8', timeout: 5000 })
      return {
        command,
        ok: !result.error && result.status === 0,
        version: `${result.stdout || result.stderr || ''}`.split(/\r?\n/)[0],
        error: result.error?.message,
      }
    }
    let apiStatus: { ok: boolean; error?: string } = { ok: true }
    try {
      await this.api.initialize()
    } catch (error) {
      apiStatus = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return {
      node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.version },
      mpv: inspect(this.config.binaries.mpv || 'mpv', '--version'),
      ffmpeg: inspect(this.config.binaries.ffmpeg || 'ffmpeg', '-version'),
      api: apiStatus,
      smtc: this.smtc.status(),
      paths: { config: this.store.getConfig() ? 'ready' : 'unavailable' },
    }
  }
}
