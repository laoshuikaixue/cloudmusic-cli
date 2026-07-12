import { execFile } from 'node:child_process'
import { AudioPipeline } from '../audio/pipeline.js'
import { NeteaseApi } from '../api/netease.js'
import { AppError } from '../core/errors.js'
import { normalizeNeteaseCookie } from '../core/cookie.js'
import { findLyricIndex } from '../core/lyrics.js'
import { AppStore } from '../core/store.js'
import { SmtcBridge, type SmtcEvent } from '../system/smtc.js'
import type {
  AppConfig,
  HistoryEntry,
  LyricLine,
  NewSongArea,
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

const playlistNameParam = (value: unknown) => {
  const name = stringParam(value, 'name')
  if ([...name].length > 40) throw new AppError('INVALID_ARGUMENT', '歌单名称不能超过 40 个字符')
  return name
}

const numberArrayParam = (value: unknown, name: string) => {
  if (!Array.isArray(value)) throw new AppError('INVALID_ARGUMENT', `${name} 必须是数组`)
  const numbers = value.map(Number)
  if (!numbers.length || numbers.some((item) => !Number.isFinite(item))) {
    throw new AppError('INVALID_ARGUMENT', `${name} 必须包含有效数字`)
  }
  return numbers
}

export class PlayerDaemon {
  private readonly store = new AppStore()
  private readonly api = new NeteaseApi(() => this.store.getCookie())
  private readonly pipeline = new AudioPipeline()
  private queue: QueueSnapshot = { songs: [], index: -1 }
  private history: HistoryEntry[] = []
  private activeHistorySong?: Song
  private config!: AppConfig
  private state: PlaybackStatus['state'] = 'idle'
  private source: SourceResult | null = null
  private currentUrl = ''
  private sourceResolvedAt = 0
  private lyrics: LyricLine[] = []
  private error?: string
  private cycle = 0
  private scrobbledCycle = -1
  private scrobblePlayedSeconds = 0
  private scrobbleLastTick = Date.now()
  private lastScrobble?: PlaybackStatus['lastScrobble']
  private likedSongIds = new Set<number>()
  private scrobbleTimer?: NodeJS.Timeout
  private smtcTimer?: NodeJS.Timeout
  private readonly smtc = new SmtcBridge()
  private controlQueue: Promise<void> = Promise.resolve()

  private enqueueControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.controlQueue.then(operation, operation)
    this.controlQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private handleSmtcEvent(event: SmtcEvent) {
    let operation: (() => Promise<unknown>) | undefined
    if (event.event === 'play') operation = () => this.resume()
    if (event.event === 'pause') operation = () => this.pause()
    if (event.event === 'stop') operation = () => this.stop()
    if (event.event === 'next') operation = () => this.next()
    if (event.event === 'previous') operation = () => this.previous()
    if (event.event === 'seek') operation = () => this.seek(event.positionMs / 1000)
    if (!operation) return
    void this.enqueueControl(operation).catch((error) => {
      this.error = error instanceof Error ? error.message : String(error)
    })
  }

  async initialize() {
    await this.store.load()
    this.config = this.store.getConfig()
    this.queue = await this.store.loadSession()
    this.history = await this.store.loadHistory()
    if (this.queue.index >= this.queue.songs.length) this.queue.index = this.queue.songs.length - 1
    this.pipeline.on('ended', () => {
      void this.enqueueControl(() => this.onEnded())
    })
    this.pipeline.on('error', (error: Error) => {
      this.state = 'error'
      this.error = error.message
    })
    this.scrobbleTimer = setInterval(() => {
      void this.maybeScrobble().catch(() => undefined)
    }, 1000)
    if (this.store.getCookie()) void this.refreshLikedSongs().catch(() => undefined)
    if (this.config.smtc.enabled) {
      await this.smtc.start((event) => this.handleSmtcEvent(event))
    }
    this.smtcTimer = setInterval(() => {
      void this.smtc.sync(this.status()).catch(() => undefined)
    }, 1000)
  }

  private get song() {
    return this.queue.songs[this.queue.index] || null
  }

  private async persistQueue() {
    await this.store.saveSession(this.queue)
  }

  private async refreshLikedSongs() {
    this.likedSongIds = new Set(await this.api.likedSongIds())
    return [...this.likedSongIds]
  }

  private resetPlaybackCycle() {
    this.cycle += 1
    this.scrobbledCycle = -1
    this.scrobblePlayedSeconds = 0
    this.scrobbleLastTick = Date.now()
  }

  private historyKey(song: Song) {
    return `netease:${song.id}`
  }

  private async finalizeHistory() {
    const active = this.activeHistorySong
    if (!active) return
    const key = this.historyKey(active)
    const entry = this.history.find((item) => this.historyKey(item.song) === key)
    if (entry) entry.listenedSeconds += Math.max(0, Math.floor(this.scrobblePlayedSeconds))
    this.activeHistorySong = undefined
    await this.store.saveHistory(this.history)
  }

  private async recordHistory(song: Song) {
    const key = this.historyKey(song)
    this.history = [
      { song, playedAt: Date.now(), listenedSeconds: 0, context: this.queue.context },
      ...this.history.filter((item) => this.historyKey(item.song) !== key),
    ].slice(0, 500)
    this.activeHistorySong = song
    await this.store.saveHistory(this.history)
  }

  private async startSong(song: Song, offset = 0) {
    await this.finalizeHistory()
    this.state = 'loading'
    this.error = undefined
    this.resetPlaybackCycle()
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
    await this.recordHistory(song)
    void this.smtc.sync(this.status())
  }

  async playSong(id: number) {
    const existing = this.queue.songs.findIndex((song) => song.id === id)
    if (existing >= 0) {
      this.queue.index = existing
    } else {
      this.queue.songs.push(await this.api.songDetail(id))
      this.queue.index = this.queue.songs.length - 1
      this.queue.context = { type: 'manual', name: '手动播放' }
    }
    await this.persistQueue()
    await this.startSong(this.song as Song)
    return this.status()
  }

  private async onEnded() {
    if (this.state === 'stopped' || this.state === 'idle') return
    await this.next(true).catch((error) => {
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
    await this.finalizeHistory()
    this.state = 'stopped'
    void this.smtc.sync(this.status())
    return this.status()
  }

  async setMode(mode: AppConfig['mode']) {
    if (!['sequence', 'repeat-one', 'shuffle'].includes(mode)) {
      throw new AppError('INVALID_ARGUMENT', `不支持的播放模式：${mode}`)
    }
    this.config = await this.store.updateConfig({ mode })
    void this.smtc.sync(this.status()).catch(() => undefined)
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
    const sourceExpired = !this.currentUrl || Date.now() - this.sourceResolvedAt > 8 * 60 * 1000
    if (sourceExpired) {
      this.source = await this.api.resolveSource(song.id, this.config)
      this.currentUrl = this.source.url
      this.sourceResolvedAt = Date.now()
    }
    const wasPaused = this.state === 'paused'
    if (sourceExpired) {
      this.state = 'loading'
      await this.pipeline.start(this.currentUrl, {
        mpvPath: this.config.binaries.mpv || 'mpv',
        ffmpegPath: this.config.binaries.ffmpeg || 'ffmpeg',
        volume: this.config.volume,
        offset: position,
      })
      this.state = 'playing'
      if (wasPaused) await this.pause()
    } else {
      await this.pipeline.seek(position)
      this.state = wasPaused ? 'paused' : 'playing'
    }
    return this.status()
  }

  async volume(value: number) {
    const volume = Math.max(0, Math.min(100, value))
    this.config = await this.store.updateConfig({ volume })
    await this.pipeline.setVolume(volume).catch(() => undefined)
    return this.status()
  }

  private async appendFmSongs() {
    const incoming = await this.api.personalFm()
    const existing = new Set(this.queue.songs.map((song) => song.id))
    const fresh = incoming.filter((song: Song) => !existing.has(song.id))
    this.queue.songs.push(...(fresh.length ? fresh : incoming))
    await this.persistQueue()
    return incoming
  }

  async next(automatic = false) {
    if (!this.queue.songs.length) throw new AppError('QUEUE_EMPTY', '播放队列为空')
    if (this.queue.context?.type === 'fm') {
      if (this.queue.index >= this.queue.songs.length - 2) await this.appendFmSongs()
      this.queue.index = Math.min(this.queue.index + 1, this.queue.songs.length - 1)
    } else if (this.config.mode === 'shuffle' && this.queue.songs.length > 1) {
      let nextIndex = this.queue.index
      while (nextIndex === this.queue.index)
        nextIndex = Math.floor(Math.random() * this.queue.songs.length)
      this.queue.index = nextIndex
    } else if (this.config.mode !== 'repeat-one' || !automatic) {
      this.queue.index = (this.queue.index + 1) % this.queue.songs.length
    }
    await this.persistQueue()
    await this.startSong(this.song as Song)
    return this.status()
  }

  async previous() {
    if (!this.queue.songs.length) throw new AppError('QUEUE_EMPTY', '播放队列为空')
    if (this.pipeline.getPosition() > 5) return this.seek(0)
    this.queue.index = (this.queue.index - 1 + this.queue.songs.length) % this.queue.songs.length
    await this.persistQueue()
    await this.startSong(this.song as Song)
    return this.status()
  }

  async playQueueIndex(index: number) {
    if (index < 0 || index >= this.queue.songs.length) {
      throw new AppError('INVALID_ARGUMENT', '队列索引超出范围')
    }
    this.queue.index = index
    await this.persistQueue()
    await this.startSong(this.song as Song)
    return this.status()
  }

  private async replaceQueue(
    songs: Song[],
    index: number,
    context: NonNullable<QueueSnapshot['context']>,
  ) {
    if (!songs.length) throw new AppError('QUEUE_EMPTY', '没有可播放的歌曲')
    this.queue = {
      songs,
      index: Math.max(0, Math.min(index, songs.length - 1)),
      context,
    }
    await this.persistQueue()
    await this.startSong(this.song as Song)
    return this.status()
  }

  async playPlaylist(id: number, index = 0) {
    const result = await this.api.playlistTracks(id)
    return this.replaceQueue(result.songs, index, {
      type: 'playlist',
      id: result.playlist.id,
      name: result.playlist.name,
    })
  }

  async playDaily(index = 0) {
    const songs = await this.api.dailySongs()
    return this.replaceQueue(songs, index, { type: 'daily', name: '每日推荐' })
  }

  async playToplist(id: number, index = 0) {
    const result = await this.api.toplist(id)
    return this.replaceQueue(result.songs, index, {
      type: 'toplist',
      id: result.playlist.id,
      name: result.playlist.name,
    })
  }

  async playNewSongs(area: NewSongArea, index = 0) {
    const result = await this.api.newSongs(area)
    return this.replaceQueue(result.songs, index, { type: 'new', id: area, name: result.name })
  }

  async playFm() {
    const songs = await this.api.personalFm()
    return this.replaceQueue(songs, 0, { type: 'fm', name: '私人 FM' })
  }

  async playHeartMode(seedId?: number) {
    const likedIds = [...this.likedSongIds]
    const seed =
      seedId || this.song?.id || likedIds[Math.floor(Math.random() * Math.max(1, likedIds.length))]
    if (!seed) throw new AppError('HEART_MODE_NO_SEED', '心动模式需要当前歌曲或喜欢歌曲作为种子')
    const result = await this.api.heartMode(seed)
    return this.replaceQueue(result.songs, 0, {
      type: 'heart',
      id: result.playlist.id,
      name: '心动模式',
    })
  }

  async trashCurrentFmSong() {
    const song = this.song
    if (!song || this.queue.context?.type !== 'fm') {
      throw new AppError('NOT_IN_FM', '当前不在私人 FM 模式')
    }
    await this.api.fmTrash(song.id)
    return this.next()
  }

  async playHistory(index = 0) {
    return this.replaceQueue(
      this.history.map((entry) => entry.song),
      index,
      { type: 'history', name: '最近播放' },
    )
  }

  async playCloud(index = 0) {
    const cloud = await this.api.cloudSongs()
    return this.replaceQueue(cloud.songs, index, { type: 'cloud', name: '音乐云盘' })
  }

  async playAlbum(id: number, index = 0) {
    const result = await this.api.albumSongs(id)
    return this.replaceQueue(result.songs, index, {
      type: 'album',
      id,
      name: result.collection.name,
    })
  }

  async playArtist(id: number, index = 0) {
    const result = await this.api.artistSongs(id)
    return this.replaceQueue(result.songs, index, {
      type: 'artist',
      id,
      name: result.collection.name,
    })
  }

  async playListeningRecord(range: 'week' | 'all', index = 0) {
    const entries = await this.api.listeningRecord(range)
    return this.replaceQueue(
      entries.map((entry) => entry.song),
      index,
      { type: 'record', name: range === 'week' ? '本周听歌排行' : '全部听歌排行' },
    )
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
      queueContext: this.queue.context,
      liked: this.song ? this.likedSongIds.has(this.song.id) : false,
      scrobbleEnabled: this.config.scrobble.enabled,
      scrobbleMode: this.config.scrobble.mode,
      lastScrobble: this.lastScrobble,
      currentLyric: this.lyrics[lyricIndex]?.text,
      nextLyric: this.lyrics[lyricIndex + 1]?.text,
      error: this.error,
    }
  }

  private async maybeScrobble() {
    const now = Date.now()
    const elapsed = Math.min(2, Math.max(0, (now - this.scrobbleLastTick) / 1000))
    this.scrobbleLastTick = now
    if (this.state === 'playing') this.scrobblePlayedSeconds += elapsed
    const song = this.song
    if (!this.config.scrobble.enabled || !song || !this.store.getCookie()) return
    if (this.scrobbledCycle === this.cycle) return
    const duration = song.duration / 1000
    if (duration <= 30) return
    const threshold = Math.min(duration / 2, 240)
    if (this.scrobblePlayedSeconds < threshold) return
    this.scrobbledCycle = this.cycle
    try {
      const result = await this.api.scrobble(
        song,
        this.scrobblePlayedSeconds,
        this.queue.context,
        this.config.scrobble.mode,
        this.source?.quality || this.config.quality,
      )
      this.lastScrobble = {
        songId: song.id,
        mode: result.mode,
        playedSeconds: Math.floor(this.scrobblePlayedSeconds),
        timestamp: new Date().toISOString(),
        ok: true,
      }
    } catch (error) {
      this.lastScrobble = {
        songId: song.id,
        mode: this.config.scrobble.mode,
        playedSeconds: Math.floor(this.scrobblePlayedSeconds),
        timestamp: new Date().toISOString(),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async shutdown() {
    if (this.scrobbleTimer) clearInterval(this.scrobbleTimer)
    if (this.smtcTimer) clearInterval(this.smtcTimer)
    this.smtc.stop()
    await this.pipeline.stop()
    await this.finalizeHistory()
  }

  async dispatch(method: string, params: Record<string, unknown> = {}) {
    const serializedMethods = new Set([
      'play',
      'pause',
      'resume',
      'toggle',
      'stop',
      'next',
      'previous',
      'seek',
      'volume',
      'mode.set',
      'queue.play',
      'queue.replace',
      'queue.append',
      'queue.add',
      'queue.next',
      'queue.remove',
      'queue.move',
      'queue.clear',
      'library.playlist.play',
      'library.playlist.create',
      'library.playlist.rename',
      'library.playlist.delete',
      'library.playlist.tracks',
      'library.daily.play',
      'library.toplist.play',
      'library.new.play',
      'library.fm.play',
      'library.fm.trash',
      'library.heart.play',
      'library.history.play',
      'library.history.clear',
      'library.history.remove',
      'library.cloud.play',
      'library.album.play',
      'library.artist.play',
      'library.record.play',
    ])
    if (serializedMethods.has(method)) {
      return this.enqueueControl(() => this.dispatchInternal(method, params))
    }
    return this.dispatchInternal(method, params)
  }

  private async dispatchInternal(method: string, params: Record<string, unknown> = {}) {
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
      case 'search.playlists':
        return this.api.searchPlaylists(
          stringParam(params.keywords, 'keywords'),
          Number(params.limit || 20),
          Number(params.offset || 0),
        )
      case 'search.albums':
        return this.api.searchAlbums(
          stringParam(params.keywords, 'keywords'),
          Number(params.limit || 20),
          Number(params.offset || 0),
        )
      case 'search.artists':
        return this.api.searchArtists(
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
      case 'mode.set':
        return this.setMode(stringParam(params.mode, 'mode') as AppConfig['mode'])
      case 'spectrum':
        return this.pipeline.getSpectrum()
      case 'lyrics': {
        const id = params.id ? numberParam(params.id, 'id') : this.song?.id
        if (!id) throw new AppError('NOT_PLAYING', '当前没有歌曲')
        return this.api.lyrics(id)
      }
      case 'queue.list':
        return this.queue
      case 'queue.play':
        return this.playQueueIndex(numberParam(params.index, 'index'))
      case 'queue.replace': {
        const ids = numberArrayParam(params.ids, 'ids')
        const songs = await Promise.all(ids.map((id) => this.api.songDetail(id)))
        return this.replaceQueue(songs, Number(params.index || 0), {
          type: params.context === 'search' ? 'search' : 'manual',
          name: typeof params.name === 'string' ? params.name : undefined,
        })
      }
      case 'queue.append': {
        const ids = numberArrayParam(params.ids, 'ids')
        const songs = await Promise.all(ids.map((id) => this.api.songDetail(id)))
        this.queue.songs.push(...songs)
        if (this.queue.index < 0) this.queue.index = 0
        await this.persistQueue()
        return this.queue
      }
      case 'queue.add': {
        const song = await this.api.songDetail(numberParam(params.id, 'id'))
        this.queue.songs.push(song)
        if (this.queue.index < 0) this.queue.index = 0
        await this.persistQueue()
        return this.queue
      }
      case 'queue.next': {
        const song = await this.api.songDetail(numberParam(params.id, 'id'))
        const currentIndex = this.queue.index
        const existingIndex = this.queue.songs.findIndex(
          (item, index) => item.id === song.id && index !== currentIndex,
        )
        if (existingIndex >= 0) {
          this.queue.songs.splice(existingIndex, 1)
          if (existingIndex < this.queue.index) this.queue.index -= 1
        }
        const insertIndex = this.queue.index >= 0 ? this.queue.index + 1 : 0
        this.queue.songs.splice(insertIndex, 0, song)
        if (this.queue.index < 0) this.queue.index = 0
        await this.persistQueue()
        return this.queue
      }
      case 'queue.remove': {
        const index = numberParam(params.index, 'index')
        if (index < 0 || index >= this.queue.songs.length) {
          throw new AppError('INVALID_ARGUMENT', '队列索引超出范围')
        }
        const removingCurrent = index === this.queue.index
        this.queue.songs.splice(index, 1)
        if (!this.queue.songs.length) {
          this.queue.index = -1
          await this.pipeline.stop()
          await this.finalizeHistory()
          this.state = 'stopped'
        } else if (removingCurrent) {
          this.queue.index = Math.min(index, this.queue.songs.length - 1)
          await this.startSong(this.song as Song)
        } else if (index < this.queue.index) {
          this.queue.index -= 1
        }
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
        const currentSong = this.song
        const [song] = this.queue.songs.splice(from, 1)
        if (song) this.queue.songs.splice(to, 0, song)
        if (currentSong) this.queue.index = this.queue.songs.indexOf(currentSong)
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
          await this.refreshLikedSongs().catch(() => undefined)
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
        await this.refreshLikedSongs().catch(() => undefined)
        return { loggedIn: true, valid: true, persisted: true, profile }
      }
      case 'login.status':
        return this.api.loginStatusSummary()
      case 'logout':
        await this.api.logout().catch(() => undefined)
        await this.store.clearCookie()
        this.likedSongIds.clear()
        return { loggedIn: false }
      case 'library.playlists':
        return this.api.userPlaylists()
      case 'library.profile':
        return this.api.userProfile(
          params.uid === undefined ? undefined : numberParam(params.uid, 'uid'),
        )
      case 'library.playlist':
        return this.api.playlistTracks(numberParam(params.id, 'id'))
      case 'library.playlist.play':
        return this.playPlaylist(
          numberParam(params.id, 'id'),
          params.index === undefined ? 0 : numberParam(params.index, 'index'),
        )
      case 'library.playlist.subscribe': {
        const id = numberParam(params.id, 'id')
        const subscribed = params.subscribed !== false
        await this.api.subscribePlaylist(id, subscribed)
        return { id, subscribed }
      }
      case 'library.playlist.create':
        return this.api.createPlaylist(playlistNameParam(params.name), params.private ? 10 : 0)
      case 'library.playlist.rename':
        return this.api.renamePlaylist(numberParam(params.id, 'id'), playlistNameParam(params.name))
      case 'library.playlist.delete':
        return this.api.deletePlaylist(numberParam(params.id, 'id'))
      case 'library.playlist.tracks':
        return this.api.updatePlaylistTracks(
          numberParam(params.id, 'id'),
          numberArrayParam(params.trackIds, 'trackIds'),
          params.operation === 'del' ? 'del' : 'add',
        )
      case 'library.daily':
        return this.api.dailySongs()
      case 'library.daily.play':
        return this.playDaily(params.index === undefined ? 0 : numberParam(params.index, 'index'))
      case 'library.daily.playlists':
        return this.api.dailyPlaylists()
      case 'library.discover.recommended':
        return this.api.personalizedPlaylists(
          params.limit === undefined ? 30 : numberParam(params.limit, 'limit'),
        )
      case 'library.discover.playlists':
        return this.api.discoverPlaylists(
          typeof params.cat === 'string' && params.cat.trim() ? params.cat.trim() : '全部',
          params.order === 'new' ? 'new' : 'hot',
          params.limit === undefined ? 50 : numberParam(params.limit, 'limit'),
          params.offset === undefined ? 0 : numberParam(params.offset, 'offset'),
        )
      case 'library.discover.highquality':
        return this.api.highqualityPlaylists(
          typeof params.cat === 'string' && params.cat.trim() ? params.cat.trim() : '全部',
          params.limit === undefined ? 50 : numberParam(params.limit, 'limit'),
          params.before === undefined ? 0 : numberParam(params.before, 'before'),
        )
      case 'library.toplists':
        return this.api.toplists()
      case 'library.toplist':
        return this.api.toplist(numberParam(params.id, 'id'))
      case 'library.toplist.play':
        return this.playToplist(
          numberParam(params.id, 'id'),
          params.index === undefined ? 0 : numberParam(params.index, 'index'),
        )
      case 'library.new':
        return this.api.newSongs(
          (params.area === undefined ? 0 : numberParam(params.area, 'area')) as NewSongArea,
        )
      case 'library.new.play':
        return this.playNewSongs(
          (params.area === undefined ? 0 : numberParam(params.area, 'area')) as NewSongArea,
          params.index === undefined ? 0 : numberParam(params.index, 'index'),
        )
      case 'library.fm':
        return this.api.personalFm()
      case 'library.fm.play':
        return this.playFm()
      case 'library.fm.trash':
        return this.trashCurrentFmSong()
      case 'library.heart': {
        const seed = params.id === undefined ? this.song?.id : numberParam(params.id, 'id')
        const likedIds = [...this.likedSongIds]
        const fallback = likedIds[Math.floor(Math.random() * Math.max(1, likedIds.length))]
        const resolvedSeed = seed || fallback
        if (!resolvedSeed) {
          throw new AppError('HEART_MODE_NO_SEED', '心动模式需要当前歌曲或喜欢歌曲作为种子')
        }
        return this.api.heartMode(resolvedSeed)
      }
      case 'library.heart.play':
        return this.playHeartMode(
          params.id === undefined ? undefined : numberParam(params.id, 'id'),
        )
      case 'library.liked.ids':
        return this.refreshLikedSongs()
      case 'library.history':
        return this.history
      case 'library.history.play':
        return this.playHistory(params.index === undefined ? 0 : numberParam(params.index, 'index'))
      case 'library.history.clear':
        this.history = []
        this.activeHistorySong = undefined
        await this.store.saveHistory(this.history)
        return this.history
      case 'library.history.remove': {
        const index = numberParam(params.index, 'index')
        if (index < 0 || index >= this.history.length) {
          throw new AppError('INVALID_ARGUMENT', '历史索引超出范围')
        }
        this.history.splice(index, 1)
        await this.store.saveHistory(this.history)
        return this.history
      }
      case 'library.cloud':
        return this.api.cloudSongs()
      case 'library.cloud.play':
        return this.playCloud(params.index === undefined ? 0 : numberParam(params.index, 'index'))
      case 'library.albums':
        return this.api.subscribedAlbums()
      case 'library.album':
        return this.api.albumSongs(numberParam(params.id, 'id'))
      case 'library.album.play':
        return this.playAlbum(
          numberParam(params.id, 'id'),
          params.index === undefined ? 0 : numberParam(params.index, 'index'),
        )
      case 'library.artists':
        return this.api.subscribedArtists()
      case 'library.artist':
        return this.api.artistSongs(numberParam(params.id, 'id'))
      case 'library.artist.play':
        return this.playArtist(
          numberParam(params.id, 'id'),
          params.index === undefined ? 0 : numberParam(params.index, 'index'),
        )
      case 'library.record': {
        const range = params.range === 'week' ? 'week' : 'all'
        return this.api.listeningRecord(range)
      }
      case 'library.record.play': {
        const range = params.range === 'week' ? 'week' : 'all'
        return this.playListeningRecord(
          range,
          params.index === undefined ? 0 : numberParam(params.index, 'index'),
        )
      }
      case 'like': {
        const id = numberParam(params.id, 'id')
        const liked = params.liked !== false
        const result = await this.api.like(id, liked)
        if (liked) this.likedSongIds.add(id)
        else this.likedSongIds.delete(id)
        return { liked, id, result }
      }
      case 'comments.song': {
        const id = params.id === undefined ? this.song?.id : numberParam(params.id, 'id')
        if (!id) throw new AppError('NOT_PLAYING', '当前没有歌曲')
        return this.api.songComments(
          id,
          params.limit === undefined ? 20 : numberParam(params.limit, 'limit'),
          params.offset === undefined ? 0 : numberParam(params.offset, 'offset'),
        )
      }
      case 'comments.playlist':
        return this.api.playlistComments(
          numberParam(params.id, 'id'),
          params.limit === undefined ? 20 : numberParam(params.limit, 'limit'),
          params.offset === undefined ? 0 : numberParam(params.offset, 'offset'),
        )
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
    const inspect = (command: string, versionArgument: string) =>
      new Promise<{ command: string; ok: boolean; version: string; error?: string }>((resolve) => {
        execFile(
          command,
          [versionArgument],
          { encoding: 'utf8', timeout: 3000, windowsHide: true },
          (error, stdout, stderr) => {
            resolve({
              command,
              ok: !error,
              version: `${stdout || stderr || ''}`.split(/\r?\n/)[0] || '',
              error: error?.message,
            })
          },
        )
      })
    let apiStatus: { ok: boolean; error?: string } = { ok: true }
    try {
      await this.api.initialize()
    } catch (error) {
      apiStatus = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const [mpv, ffmpeg] = await Promise.all([
      inspect(this.config.binaries.mpv || 'mpv', '--version'),
      inspect(this.config.binaries.ffmpeg || 'ffmpeg', '-version'),
    ])
    return {
      node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.version },
      mpv,
      ffmpeg,
      api: apiStatus,
      smtc: this.smtc.status(),
      paths: { config: this.store.getConfig() ? 'ready' : 'unavailable' },
    }
  }
}
