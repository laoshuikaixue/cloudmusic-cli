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
  | 'similar'
  | 'dj'
export type ScrobbleMode = 'ncbl' | 'legacy'
export type ReplayGainMode = 'off' | 'track' | 'album'
export type SleepTimerMode = 'timer' | 'song-end'
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
  type: 'album' | 'artist' | 'radio'
  cover?: string
  subtitle?: string
  count?: number
  /** 计数单位，默认「首」；播客节目用「期」 */
  countUnit?: string
}

export interface ListeningRecordEntry {
  song: Song
  playCount: number
  score: number
}

export interface ListenReport {
  type: 'week' | 'month' | 'year'
  startTime: number
  endTime: number
  playMinutes: number
  listenDays: number
  songCount: number
  dailyDurations: { date: string; minutes: number }[]
  topSongs: { id: number; name: string; text?: string }[]
  topArtists: { id: number; name: string; text?: string }[]
  styles: { name: string; percent: number }[]
  languages: { language: string; percent: number; songCount: number }[]
  ages: { age: string; songCount: number }[]
}

export interface ListenStats {
  totalPlaySeconds: number
  report: ListenReport
}

export interface TodayListenSong {
  id: number
  name: string
  artists: string[]
  lastPlayTime: number
}

export interface RecentPlayEntry {
  song: Song
  playTime: number
  os?: string
}

export interface SigninTaskResult {
  task: string
  success: boolean
  repeated: boolean
  message: string
  point?: number
}

export interface SigninResult {
  daily: SigninTaskResult
  yunbei: SigninTaskResult
}

export interface SigninOverview {
  todaySignedIn: boolean
  records: { day: string; signed: boolean }[]
  progress: {
    id: number
    description: string
    currentProgress: number
    maxProgressReached: number
    repeatType?: string
    calcType?: string
  }[]
  growth?: { level: number; levelName?: string; growthPoint: number; maxLevel: boolean }
  yunbei?: { level: number; balance: number }
}

export interface RecentResourceEntry {
  id: number
  name: string
  cover?: string
  playTime: number
  /** 歌单/专辑的曲目数或播客节目数 */
  count?: number
}

export interface UserProfile {
  userId: number
  nickname: string
  avatar?: string
  signature?: string
  level: number
  vipType: number
  listenSongs: number
  follows: number
  followeds: number
  playlistCount: number
  eventCount: number
  createTime?: number
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
  endTime: number
  text: string
  words?: LyricWord[]
  translation?: string
  romanization?: string
  isBackground?: boolean
  isDuet?: boolean
}

export interface LyricWord {
  startTime: number
  endTime: number
  text: string
  romanization?: string
}

export type LyricFormat = 'ttml' | 'qrc' | 'yrc' | 'lrc'
export type LyricSource = 'netease' | 'amll' | 'qqmusic'

/** 歌词显示模式：原文、原文+注释行、只显示译文、只显示罗马音 */
export type LyricDisplayMode = 'original' | 'both' | 'translation' | 'romanization'

export interface LyricView {
  mode: LyricDisplayMode
  /** 逐字高亮，关闭后按整行显示 */
  karaoke: boolean
  /** 是否显示背景人声行 */
  background: boolean
  /** 歌词时间轴偏移（毫秒），正值让歌词更早出现 */
  offsetMs: number
}

export interface LyricResult {
  lines: LyricLine[]
  format: LyricFormat
  source: LyricSource
  upgraded: boolean
  raw?: unknown
  match?: {
    status: 'accepted' | 'rejected' | 'uncertain'
    reason: string
    metrics: Record<string, number | undefined>
  }
}

export interface SpectrumFrame {
  position: number
  bins: number[]
  peak: number
  generation?: number
}

export interface PlaybackStatus {
  daemon: 'running'
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error'
  song: Song | null
  position: number
  duration: number
  volume: number
  speed: number
  sleep?: SleepStatus
  mode: PlaybackMode
  source: PlaybackSource
  sourceName?: string
  trial: boolean
  quality?: string
  /** 用户设定的音质，与实际音质不同时说明发生了降级 */
  requestedQuality?: string
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
  currentLyricLine?: LyricLine
  nextLyricLine?: LyricLine
  previousLyricLines?: LyricLine[]
  upcomingLyricLines?: LyricLine[]
  backgroundLyricLines?: LyricLine[]
  lyricFormat?: LyricFormat
  lyricSource?: LyricSource
  lyricsUpgraded?: boolean
  lyricView?: LyricView
  spectrumGeneration?: number
  sourceFailure?: SourceFailure
  error?: string
}

export interface SleepStatus {
  mode: SleepTimerMode
  /** 定时器到点的毫秒时间戳；song-end 模式没有到点时间 */
  endsAt?: number
  remainingSeconds?: number
}

export interface ClassLinkStatus {
  enabled: boolean
  configured: boolean
  connected: boolean
  endpoint: string
  lastSuccessAt?: number
  lastError?: string
}

export interface AppConfig {
  quality: string
  /** 目标音质不可用时是否沿音质阶梯降级 */
  qualityFallback: boolean
  /** 单曲取不到音源时是否自动切到下一首 */
  skipOnError: boolean
  player: {
    /** 播放倍速，作用于 mpv 输出 */
    speed: number
    replayGain: ReplayGainMode
    /** ReplayGain 前置增益（dB） */
    replayGainPreamp: number
    /** 起播/恢复淡入与暂停/切歌淡出的时长，0 表示关闭 */
    fadeMs: number
  }
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
  classLink: {
    enabled: boolean
    port: number
  }
  lyrics: {
    upgrade: boolean
    enableTtml: boolean
    enableQrc: boolean
    amllDbServer: string
    display: LyricDisplayMode
    karaoke: boolean
    background: boolean
    offsetMs: number
  }
}

/** 允许只填部分字段的配置补丁 */
export interface ConfigPatch {
  quality?: string
  qualityFallback?: boolean
  skipOnError?: boolean
  player?: Partial<AppConfig['player']>
  volume?: number
  mode?: PlaybackMode
  allowTrial?: boolean
  unblock?: Partial<AppConfig['unblock']>
  binaries?: Partial<AppConfig['binaries']>
  scrobble?: Partial<AppConfig['scrobble']>
  smtc?: Partial<AppConfig['smtc']>
  classLink?: Partial<AppConfig['classLink']>
  lyrics?: Partial<AppConfig['lyrics']>
}

export interface QueueSnapshot {
  songs: Song[]
  index: number
  context?: QueueContext
  /** 随机播放模式下,本轮尚未播放的歌曲 id 池 */
  shufflePool?: number[]
  /** 随机播放模式下,已切走歌曲 id 的回退栈 */
  shuffleHistory?: number[]
}

export interface SourceResult {
  url: string
  source: Exclude<PlaybackSource, null>
  sourceName?: string
  trial: boolean
  quality?: string
  /** 用户设定的目标音质，与实际拿到的音质不同时说明发生了降级 */
  requestedQuality?: string
}

/** 无法播放的原因分类，字段值全部来自接口真实响应 */
export type SourceFailureReason =
  | 'no_copyright'
  | 'region_blocked'
  | 'vip_required'
  | 'trial_disabled'
  | 'no_url'
  | 'request_failed'

export interface SourceFailure {
  reason: SourceFailureReason
  message: string
  /** 接口返回的 fee 原值：0 免费 / 1 VIP / 4 需购买 / 8 受限音质 */
  fee?: number
  /** 逐个音质档位尝试后仍失败时，记录每档的 data[].code */
  triedLevels?: { level: string; code?: number }[]
}

export interface SourceUnavailableError {
  failure: SourceFailure
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
