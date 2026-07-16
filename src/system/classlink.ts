import { createHash, randomUUID } from 'node:crypto'
import type {
  AppConfig,
  ClassLinkStatus,
  LyricLine,
  LyricResult,
  PlaybackStatus,
  Song,
} from '../core/types.js'
import { VERSION } from '../version.js'

const PROTOCOL_VERSION = 1
const CONNECTOR_VERSION = '1.0.0'
const DEFAULT_PORT = 50064
const ANCHOR_INTERVAL_MS = 1000
const HEARTBEAT_INTERVAL_MS = 10_000
const REQUEST_TIMEOUT_MS = 5000
const MAX_COVER_BYTES = 2 * 1024 * 1024
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000]

interface ClassLinkSnapshot {
  song: Song | null
  trackRevision: number
  lyricRevision: number
  lyrics: LyricResult
  state: PlaybackStatus['state']
  positionMs: number
}

interface CoverPayload {
  trackKey: string
  revision: number
  hash: string
  mimeType: string
  data: Buffer
}

const toMilliseconds = (seconds: number) => Math.max(0, Math.round(seconds * 1000))

const serializeWords = (line: LyricLine) => {
  if (line.words?.length) {
    return line.words.map((word) => ({
      startTime: toMilliseconds(word.startTime),
      endTime: toMilliseconds(word.endTime),
      word: word.text,
      romanWord: word.romanization || undefined,
    }))
  }
  return [
    {
      startTime: toMilliseconds(line.time),
      endTime: toMilliseconds(line.endTime),
      word: line.text,
    },
  ]
}

export const serializeClassLinkLyrics = (result: LyricResult) => ({
  status: result.lines.length ? 'ready' : 'none',
  source: result.source,
  format: result.format,
  platform: result.source === 'qqmusic' ? 'qqmusic' : 'netease',
  lines: result.lines.map((line) => ({
    words: serializeWords(line),
    translatedLyric: line.translation || '',
    romanLyric: line.romanization || '',
    startTime: toMilliseconds(line.time),
    endTime: toMilliseconds(line.endTime),
    isBG: Boolean(line.isBackground),
    isDuet: Boolean(line.isDuet),
  })),
})

const playbackState = (state: PlaybackStatus['state']) => {
  if (state === 'playing') return 'playing'
  if (state === 'paused') return 'paused'
  return 'stopped'
}

const trackKeyOf = (song: Song | null) => (song ? `netease:${song.id}` : null)

const coverUrlOf = (song: Song) => {
  const source = song.cover || song.album.cover
  if (!source) return null
  try {
    const url = new URL(source)
    url.searchParams.set('param', '300y300')
    return url.toString()
  } catch {
    return source
  }
}

const detectImageMimeType = (data: Buffer) => {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length >= 8 && data[0] === 0x89 && data.subarray(1, 4).toString('ascii') === 'PNG') {
    return 'image/png'
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

const readLimitedBody = async (response: Response) => {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_COVER_BYTES) throw new Error('ClassLink cover is too large')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks, length)
}

export class ClassLinkBridge {
  private readonly instanceId = randomUUID()
  private readonly startedAtUnixMs = Date.now()
  private config: AppConfig['classLink'] = { enabled: false, port: DEFAULT_PORT }
  private token = ''
  private latest: ClassLinkSnapshot | null = null
  private stateRevision = 0
  private anchorSequence = 0
  private coverRevision = 0
  private observedTrackRevision = -1
  private observedLyricRevision = -1
  private observedPlaybackState = ''
  private stateDirty = false
  private anchorDirty = false
  private heartbeatDirty = false
  private currentCover: CoverPayload | null = null
  private coverDirty = false
  private coverGeneration = 0
  private coverController?: AbortController
  private flushing = false
  private stopped = false
  private connected = false
  private lastSuccessAt = 0
  private lastAnchorAt = 0
  private lastHeartbeatAt = 0
  private lastError?: string
  private retryAttempt = 0
  private retryAt = 0
  private retryTimer?: NodeJS.Timeout

  configure(config: AppConfig['classLink'], token: string) {
    const normalized = {
      enabled: Boolean(config.enabled),
      port:
        Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535
          ? config.port
          : DEFAULT_PORT,
    }
    const changed =
      normalized.enabled !== this.config.enabled ||
      normalized.port !== this.config.port ||
      token !== this.token
    this.config = normalized
    this.token = token.trim()
    if (!changed) return
    this.connected = false
    this.lastError = undefined
    this.retryAttempt = 0
    this.retryAt = 0
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.markStateDirty()
    if (!this.config.enabled || !this.token) {
      this.coverGeneration += 1
      this.coverController?.abort()
      this.coverController = undefined
      this.currentCover = null
      this.coverDirty = false
      return
    }
    if (this.latest) this.refreshCover(this.latest)
    this.scheduleFlush()
  }

  sync(snapshot: ClassLinkSnapshot) {
    if (this.stopped) return
    this.latest = snapshot
    const trackChanged = snapshot.trackRevision !== this.observedTrackRevision
    const lyricChanged = snapshot.lyricRevision !== this.observedLyricRevision
    const stateChanged = snapshot.state !== this.observedPlaybackState
    if (trackChanged) {
      this.observedTrackRevision = snapshot.trackRevision
      if (this.config.enabled && this.token) {
        this.refreshCover(snapshot)
      } else {
        this.coverGeneration += 1
        this.coverController?.abort()
        this.coverController = undefined
        this.currentCover = null
        this.coverDirty = false
      }
    }
    if (lyricChanged) this.observedLyricRevision = snapshot.lyricRevision
    if (stateChanged) this.observedPlaybackState = snapshot.state
    if (trackChanged || lyricChanged || stateChanged) this.markStateDirty()

    const now = Date.now()
    if (snapshot.state === 'playing') {
      if (stateChanged || now - this.lastAnchorAt >= ANCHOR_INTERVAL_MS) {
        this.anchorSequence += 1
        this.anchorDirty = true
      }
    } else if (now - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      this.heartbeatDirty = true
    }
    this.scheduleFlush()
  }

  status(): ClassLinkStatus {
    return {
      enabled: this.config.enabled,
      configured: Boolean(this.token),
      connected: this.connected,
      endpoint: `http://127.0.0.1:${this.config.port}`,
      lastSuccessAt: this.lastSuccessAt || undefined,
      lastError: this.lastError,
    }
  }

  stop() {
    this.stopped = true
    this.coverController?.abort()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private markStateDirty() {
    this.stateRevision += 1
    this.stateDirty = true
  }

  private scheduleFlush(delay = 0) {
    if (this.stopped || !this.config.enabled || !this.token) return
    if (delay > 0) {
      if (this.retryTimer) return
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        void this.flush()
      }, delay)
      return
    }
    queueMicrotask(() => void this.flush())
  }

  private async flush() {
    if (this.flushing || this.stopped || !this.config.enabled || !this.token || !this.latest) {
      return
    }
    const retryDelay = this.retryAt - Date.now()
    if (retryDelay > 0) {
      this.scheduleFlush(retryDelay)
      return
    }
    this.flushing = true
    try {
      while (this.hasPendingWork()) {
        if (this.stateDirty) {
          const revision = this.stateRevision
          await this.postJson('/v1/state', this.buildStatePayload())
          if (revision === this.stateRevision) this.stateDirty = false
          this.markConnected()
          continue
        }
        if (this.coverDirty && this.currentCover) {
          const cover = this.currentCover
          await this.postCover(cover)
          if (cover === this.currentCover) this.coverDirty = false
          this.markConnected()
          continue
        }
        if (this.anchorDirty) {
          const sequence = this.anchorSequence
          await this.postJson('/v1/anchor', this.buildAnchorPayload())
          if (sequence === this.anchorSequence) this.anchorDirty = false
          this.lastAnchorAt = Date.now()
          this.markConnected()
          continue
        }
        if (this.heartbeatDirty) {
          await this.postJson('/v1/heartbeat', this.buildHeartbeatPayload())
          this.heartbeatDirty = false
          this.lastHeartbeatAt = Date.now()
          this.markConnected()
        }
      }
    } catch (error) {
      this.connected = false
      this.lastError = error instanceof Error ? error.message : String(error)
      this.markStateDirty()
      const delay =
        RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)] ?? 10_000
      this.retryAttempt += 1
      this.retryAt = Date.now() + delay
      this.scheduleFlush(delay)
    } finally {
      this.flushing = false
      if (this.hasPendingWork() && this.retryAt <= Date.now()) this.scheduleFlush()
    }
  }

  private hasPendingWork() {
    return this.stateDirty || this.coverDirty || this.anchorDirty || this.heartbeatDirty
  }

  private markConnected() {
    this.connected = true
    this.lastSuccessAt = Date.now()
    this.lastError = undefined
    this.retryAttempt = 0
    this.retryAt = 0
  }

  private buildStatePayload() {
    const snapshot = this.latest as ClassLinkSnapshot
    const trackKey = trackKeyOf(snapshot.song)
    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.instanceId,
      startedAtUnixMs: this.startedAtUnixMs,
      appId: 'cloudmusic-cli',
      appName: 'CloudMusic CLI',
      connectorName: 'CloudMusic CLI ClassLink',
      connectorVersion: CONNECTOR_VERSION,
      appVersion: VERSION,
      stateRevision: this.stateRevision,
      trackRevision: snapshot.trackRevision,
      trackKey,
      track: snapshot.song
        ? {
            id: String(snapshot.song.id),
            source: 'netease',
            title: snapshot.song.name,
            artists: snapshot.song.artists.map((artist) => ({ name: artist.name })),
            album: { name: snapshot.song.album.name },
            duration: snapshot.song.duration,
          }
        : null,
      lyrics: {
        ...serializeClassLinkLyrics(snapshot.lyrics),
        status:
          snapshot.state === 'loading' && !snapshot.lyrics.lines.length
            ? 'loading'
            : snapshot.lyrics.lines.length
              ? 'ready'
              : 'none',
        revision: snapshot.lyricRevision,
      },
      playback: this.buildPlaybackPayload(snapshot),
      cover: this.currentCover
        ? {
            revision: this.currentCover.revision,
            hash: this.currentCover.hash,
            mimeType: this.currentCover.mimeType,
          }
        : null,
    }
  }

  private buildAnchorPayload() {
    const snapshot = this.latest as ClassLinkSnapshot
    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.instanceId,
      startedAtUnixMs: this.startedAtUnixMs,
      sequence: this.anchorSequence,
      trackKey: trackKeyOf(snapshot.song),
      playback: this.buildPlaybackPayload(snapshot),
    }
  }

  private buildHeartbeatPayload() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.instanceId,
      startedAtUnixMs: this.startedAtUnixMs,
      trackKey: trackKeyOf(this.latest?.song || null),
    }
  }

  private buildPlaybackPayload(snapshot: ClassLinkSnapshot) {
    return {
      positionMs: Math.max(0, Math.round(snapshot.positionMs)),
      state: playbackState(snapshot.state),
      speed: 1,
      lyricOffsetMs: 0,
      sentAtUnixMs: Date.now(),
    }
  }

  private async postJson(path: string, value: unknown) {
    await this.request(path, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
  }

  private async postCover(cover: CoverPayload) {
    const query = new URLSearchParams({
      protocolVersion: String(PROTOCOL_VERSION),
      instanceId: this.instanceId,
      startedAtUnixMs: String(this.startedAtUnixMs),
      revision: String(cover.revision),
      trackKey: cover.trackKey,
      hash: cover.hash,
    })
    await this.request(`/v1/cover?${query.toString()}`, {
      headers: { 'Content-Type': cover.mimeType },
      body: cover.data,
    })
  }

  private async request(path: string, init: RequestInit) {
    const response = await fetch(`http://127.0.0.1:${this.config.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
    })
    if (!response.ok) throw new Error(`ClassLink HTTP ${response.status}`)
  }

  private refreshCover(snapshot: ClassLinkSnapshot) {
    const generation = ++this.coverGeneration
    this.coverController?.abort()
    this.coverController = undefined
    this.currentCover = null
    this.coverDirty = false
    this.markStateDirty()
    const trackKey = trackKeyOf(snapshot.song)
    if (!snapshot.song || !trackKey) return
    const url = coverUrlOf(snapshot.song)
    if (!url) return
    const controller = new AbortController()
    this.coverController = controller
    void (async () => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        })
        if (!response.ok) throw new Error(`Cover HTTP ${response.status}`)
        const declaredLength = Number(response.headers.get('content-length') || 0)
        if (declaredLength > MAX_COVER_BYTES) throw new Error('ClassLink cover is too large')
        const data = await readLimitedBody(response)
        const mimeType = detectImageMimeType(data)
        if (!mimeType || !data.length) throw new Error('Unsupported ClassLink cover format')
        if (
          generation !== this.coverGeneration ||
          trackKey !== trackKeyOf(this.latest?.song || null)
        ) {
          return
        }
        this.coverRevision += 1
        this.currentCover = {
          trackKey,
          revision: this.coverRevision,
          hash: createHash('sha256').update(data).digest('hex'),
          mimeType,
          data,
        }
        this.coverDirty = true
        this.markStateDirty()
        this.scheduleFlush()
      } catch {
        if (controller.signal.aborted) return
        if (generation === this.coverGeneration) {
          this.currentCover = null
          this.coverDirty = false
        }
      }
    })()
  }
}
