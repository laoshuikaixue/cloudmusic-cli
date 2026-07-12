export type PlaybackSource = 'official' | 'unblock' | 'trial' | 'local' | null
export type PlaybackMode = 'sequence' | 'repeat-one' | 'shuffle'
export type QueueContextType =
  | 'manual'
  | 'search'
  | 'playlist'
  | 'daily'
  | 'fm'
  | 'heart'
  | 'liked'
  | 'history'
  | 'cloud'
  | 'album'
  | 'artist'
  | 'record'
  | 'toplist'
  | 'new'
export type ScrobbleMode = 'ncbl' | 'legacy'
export type NewSongArea = 0 | 7 | 96 | 8 | 16

export interface Artist {
  id?: number
  name: string
}

export interface Album {
  id?: number
  name: string
  cover?: string
}

export interface Song {
  id: number
  name: string
  artists: Artist[]
  album: Album
  duration: number
  cover?: string
  fee?: number
  quality?: string
}

export interface HistoryEntry {
  song: Song
  playedAt: number
  listenedSeconds: number
  context?: QueueContext
}

export interface CloudLibrary {
  songs: Song[]
  count: number
  size: number
  maxSize: number
}

export interface CollectionSummary {
  id: number
  name: string
  type: 'album' | 'artist'
  cover?: string
  subtitle?: string
  count?: number
}

export interface ListeningRecordEntry {
  song: Song
  playCount: number
  score: number
}

export interface PlaylistSummary {
  id: number
  name: string
  cover?: string
  trackCount: number
  description?: string
  creator?: { id?: number; name: string }
  subscribed?: boolean
  specialType?: number
  updateFrequency?: string
}

export interface MusicComment {
  id: number
  content: string
  time: number
  likedCount: number
  liked: boolean
  user: {
    id: number
    nickname: string
    avatar?: string
  }
}

export interface CommentPage {
  comments: MusicComment[]
  hotComments: MusicComment[]
  total: number
  more: boolean
}

export interface QueueContext {
  type: QueueContextType
  id?: number
  name?: string
}

export interface LyricLine {
  time: number
  text: string
  translation?: string
  romanization?: string
}

export interface SpectrumFrame {
  position: number
  bins: number[]
  peak: number
}

export interface PlaybackStatus {
  daemon: 'running'
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error'
  song: Song | null
  position: number
  duration: number
  volume: number
  mode: PlaybackMode
  source: PlaybackSource
  sourceName?: string
  trial: boolean
  quality?: string
  queueLength: number
  queueIndex: number
  queueContext?: QueueContext
  liked?: boolean
  scrobbleEnabled?: boolean
  scrobbleMode?: ScrobbleMode
  lastScrobble?: {
    songId: number
    mode: ScrobbleMode
    playedSeconds: number
    timestamp: string
    ok: boolean
    error?: string
  }
  currentLyric?: string
  nextLyric?: string
  error?: string
}

export interface AppConfig {
  quality: string
  volume: number
  mode: PlaybackMode
  allowTrial: boolean
  unblock: {
    enabled: boolean
    source: string
  }
  binaries: {
    mpv?: string
    ffmpeg?: string
  }
  scrobble: {
    enabled: boolean
    mode: ScrobbleMode
    configured: boolean
  }
  smtc: {
    enabled: boolean
  }
}

export interface QueueSnapshot {
  songs: Song[]
  index: number
  context?: QueueContext
}

export interface SourceResult {
  url: string
  source: Exclude<PlaybackSource, null>
  sourceName?: string
  trial: boolean
  quality?: string
}

export interface RpcRequest {
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface RpcResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
    details?: unknown
  }
}

export interface RpcEvent {
  event: string
  data: unknown
}

export interface OutputEnvelope<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; details?: unknown }
  meta: { version: string; timestamp: string }
}
