export type PlaybackSource = 'official' | 'unblock' | 'trial' | 'local' | null
export type PlaybackMode = 'sequence' | 'repeat-one' | 'shuffle'

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
  }
  smtc: {
    enabled: boolean
  }
}

export interface QueueSnapshot {
  songs: Song[]
  index: number
}

export interface SourceResult {
  url: string
  source: Exclude<PlaybackSource, null | 'local'>
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
