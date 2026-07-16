import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import qrcode from 'qrcode-terminal'
import { requestDaemonResilient, subscribeDaemon } from '../ipc/client.js'
import { normalizeControlInput } from './controls.js'
import { getPlayerLayout, renderProgressBar } from './layout.js'
import {
  getLyricLineTransition,
  getSustainGlowIntensity,
  getWaitingCircles,
  interpolateWordGraphemes,
  mixHexColors,
} from './lyric-highlight.js'
import {
  isSpectrumFrameSynchronized,
  renderSpectrumBars,
  smoothSpectrumBins,
} from './spectrum-visualizer.js'
import { canRenderTerminalFrame, TUI_FRAME_INTERVAL_MS } from './rendering.js'
import type {
  AppConfig,
  ClassLinkStatus,
  CloudLibrary,
  CollectionSummary,
  CommentPage,
  HistoryEntry,
  ListeningRecordEntry,
  LyricLine,
  MusicComment,
  PlaybackMode,
  PlaybackStatus,
  PlaylistSummary,
  QueueSnapshot,
  Song,
  SpectrumFrame,
  UserProfile,
} from '../core/types.js'

type PageMode =
  | 'normal'
  | 'search'
  | 'results'
  | 'search-playlists'
  | 'search-collections'
  | 'cookie'
  | 'qr'
  | 'queue'
  | 'library'
  | 'playlists'
  | 'playlist-edit'
  | 'playlist-picker'
  | 'tracks'
  | 'settings'
  | 'classlink'
  | 'classlink-token'
  | 'classlink-port'
  | 'account'
  | 'comments'
  | 'collections'
  | 'new-regions'
  | 'discover-categories'

type LibrarySource =
  | { type: 'playlist'; id: number; name: string; owned: boolean }
  | { type: 'daily'; name: string }
  | { type: 'history'; name: string }
  | { type: 'cloud'; name: string }
  | { type: 'album'; id: number; name: string }
  | { type: 'artist'; id: number; name: string }
  | { type: 'record'; range: 'week' | 'all'; name: string }
  | { type: 'toplist'; id: number; name: string }
  | { type: 'new'; area: number; name: string }

type SearchType = 'song' | 'playlist' | 'album' | 'artist'

const searchTypes: SearchType[] = ['song', 'playlist', 'album', 'artist']
const searchTypeLabels: Record<SearchType, string> = {
  song: '歌曲',
  playlist: '歌单',
  album: '专辑',
  artist: '歌手',
}

const newSongRegions = [
  { area: 0, name: '全部新歌' },
  { area: 7, name: '华语新歌' },
  { area: 96, name: '欧美新歌' },
  { area: 8, name: '日本新歌' },
  { area: 16, name: '韩国新歌' },
] as const

const discoverEntries = [
  { kind: 'recommended', name: '为你推荐' },
  { kind: 'highquality', name: '精品歌单' },
  ...[
    '全部',
    '华语',
    '欧美',
    '日语',
    '韩语',
    '粤语',
    '流行',
    '摇滚',
    '民谣',
    '电子',
    '说唱',
    'ACG',
    '古典',
    '治愈',
  ].map((name) => ({ kind: 'category', name })),
] as Array<{ kind: 'recommended' | 'highquality' | 'category'; name: string }>

const callDaemon = async <T = unknown,>(method: string, params?: Record<string, unknown>) => {
  return requestDaemonResilient<T>(method, params)
}

interface AccountStatus {
  loggedIn: boolean
  valid: boolean
  profile?: { userId: number; nickname: string; vipType: number }
}

const emptyStatus: PlaybackStatus = {
  daemon: 'running',
  state: 'idle',
  song: null,
  position: 0,
  duration: 0,
  volume: 80,
  mode: 'sequence',
  source: null,
  trial: false,
  queueLength: 0,
  queueIndex: -1,
  spectrumGeneration: 0,
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '00:00'
  const minute = Math.floor(seconds / 60)
  const second = Math.floor(seconds % 60)
  return `${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

const TimedLyricLine = ({
  line,
  position,
  waiting = false,
  waitingUntil = 0,
  placeholderAlignRight = false,
  emphasis = 1,
}: {
  line?: LyricLine
  position: number
  waiting?: boolean
  waitingUntil?: number
  placeholderAlignRight?: boolean
  emphasis?: number
}) => {
  if (!line) {
    const circles = waiting ? getWaitingCircles(position, waitingUntil) : []
    return (
      <Box width="100%" justifyContent={placeholderAlignRight ? 'flex-end' : 'flex-start'}>
        {waiting ? (
          <Text bold>
            {circles.map((circle, index) => (
              <Text
                key={index}
                color={mixHexColors(
                  '#000000',
                  mixHexColors('#475569', '#f8fafc', circle.intensity),
                  circle.opacity,
                )}
              >
                {process.env.NO_COLOR
                  ? circle.opacity > 0.66
                    ? circle.glyph
                    : circle.opacity > 0.33
                      ? '•'
                      : circle.opacity > 0.06
                        ? '·'
                        : ' '
                  : circle.glyph}
                {index < circles.length - 1 ? ' ' : ''}
              </Text>
            ))}
          </Text>
        ) : (
          <Text dimColor>暂无同步歌词</Text>
        )}
      </Box>
    )
  }
  const prefix = line.isBackground ? '↳ ' : line.isDuet ? '↔ ' : ''
  const contextColor = '#64748b'
  const lineColor = line.isBackground ? '#e879f9' : '#22d3ee'
  if (!line.words?.length) {
    return (
      <Box width="100%" justifyContent={line.isDuet ? 'flex-end' : 'flex-start'}>
        <Text bold color={mixHexColors(contextColor, lineColor, emphasis)}>
          {prefix}
          {line.text}
        </Text>
      </Box>
    )
  }
  return (
    <Box width="100%" justifyContent={line.isDuet ? 'flex-end' : 'flex-start'}>
      <Text bold>
        <Text color={mixHexColors(contextColor, lineColor, emphasis)}>{prefix}</Text>
        {line.words.flatMap((word, wordIndex) =>
          interpolateWordGraphemes(word.text, word.startTime, word.endTime, position).map(
            (grapheme, graphemeIndex) => {
              const inactiveColor = '#94a3b8'
              const activeColor = lineColor
              const baseColor =
                grapheme.phase === 'completed'
                  ? activeColor
                  : grapheme.phase === 'active'
                    ? mixHexColors(inactiveColor, activeColor, grapheme.brightness)
                    : inactiveColor
              const glow =
                grapheme.phase === 'upcoming'
                  ? 0
                  : getSustainGlowIntensity(line.words || [], wordIndex, line.endTime, position)
              const color = glow
                ? mixHexColors(baseColor, '#ffffff', Math.min(0.78, glow * 0.78))
                : baseColor
              return (
                <Text
                  key={`${word.startTime}-${wordIndex}-${graphemeIndex}`}
                  color={mixHexColors(contextColor, color, emphasis)}
                >
                  {grapheme.text}
                </Text>
              )
            },
          ),
        )}
      </Text>
    </Box>
  )
}

const ContextLyricLine = ({
  line,
  emphasis = 0,
  emphasisColor = '#22d3ee',
}: {
  line: LyricLine
  emphasis?: number
  emphasisColor?: string
}) => (
  <Box width="100%" justifyContent={line.isDuet ? 'flex-end' : 'flex-start'}>
    <Text
      bold={emphasis > 0.001}
      color={process.env.NO_COLOR ? undefined : mixHexColors('#64748b', emphasisColor, emphasis)}
    >
      {line.isDuet ? '↔ ' : ''}
      {line.text}
    </Text>
  </Box>
)

const songLabel = (song: Song) => {
  const artists = song.artists.map((artist) => artist.name).join(' / ')
  return `${song.name} — ${artists}`
}

const Spectrum = ({ frame, width }: { frame: SpectrumFrame; width: number }) => {
  const usableWidth = Math.max(12, width)
  const lines = useMemo(() => {
    return renderSpectrumBars(frame.bins, usableWidth)
  }, [frame, usableWidth])
  return (
    <Box flexDirection="column">
      <Text color={process.env.NO_COLOR ? undefined : 'white'}>{lines[0]}</Text>
      <Text color={process.env.NO_COLOR ? undefined : 'white'}>{lines[1]}</Text>
    </Box>
  )
}

export const NowPlaying = () => {
  const { exit } = useApp()
  const [status, setStatus] = useState(emptyStatus)
  const [spectrum, setSpectrum] = useState<SpectrumFrame>({
    position: 0,
    bins: new Array(64).fill(0),
    peak: 0,
  })
  const [account, setAccount] = useState<AccountStatus>({ loggedIn: false, valid: false })
  const [accountProfile, setAccountProfile] = useState<UserProfile | null>(null)
  const [queue, setQueue] = useState<QueueSnapshot>({ songs: [], index: -1 })
  const [mode, setMode] = useState<PageMode>('normal')
  const [inputValue, setInputValue] = useState('')
  const [searchResults, setSearchResults] = useState<Song[]>([])
  const [searchType, setSearchType] = useState<SearchType>('song')
  const [searchPlaylists, setSearchPlaylists] = useState<PlaylistSummary[]>([])
  const [searchCollections, setSearchCollections] = useState<CollectionSummary[]>([])
  const [searchCollectionType, setSearchCollectionType] = useState<'album' | 'artist'>('album')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [queueIndex, setQueueIndex] = useState(0)
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const [playlistPageTitle, setPlaylistPageTitle] = useState('我的歌单')
  const [playlistPageKind, setPlaylistPageKind] = useState<
    'library' | 'daily' | 'toplist' | 'discover'
  >('library')
  const [playlistEditAction, setPlaylistEditAction] = useState<'create' | 'rename'>('create')
  const [playlistEditTarget, setPlaylistEditTarget] = useState<PlaylistSummary | null>(null)
  const [playlistPickerSong, setPlaylistPickerSong] = useState<Song | null>(null)
  const [playlistPickerReturnMode, setPlaylistPickerReturnMode] = useState<PageMode>('normal')
  const [deleteArmedId, setDeleteArmedId] = useState<number | null>(null)
  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [collectionType, setCollectionType] = useState<'album' | 'artist'>('album')
  const [librarySongs, setLibrarySongs] = useState<Song[]>([])
  const [libraryIndex, setLibraryIndex] = useState(0)
  const [librarySource, setLibrarySource] = useState<LibrarySource | null>(null)
  const [trackReturnMode, setTrackReturnMode] = useState<PageMode>('library')
  const [settingsConfig, setSettingsConfig] = useState<AppConfig | null>(null)
  const [settingsIndex, setSettingsIndex] = useState(0)
  const [classLinkStatus, setClassLinkStatus] = useState<ClassLinkStatus | null>(null)
  const [classLinkIndex, setClassLinkIndex] = useState(0)
  const [accountIndex, setAccountIndex] = useState(0)
  const [qrText, setQrText] = useState('')
  const [comments, setComments] = useState<MusicComment[]>([])
  const [commentIndex, setCommentIndex] = useState(0)
  const [commentTitle, setCommentTitle] = useState('歌曲评论')
  const [commentTotal, setCommentTotal] = useState(0)
  const [commentReturnMode, setCommentReturnMode] = useState<PageMode>('normal')
  const [message, setMessage] = useState('按 / 搜索歌曲，按 o 打开设置')
  const [terminalWidth, setTerminalWidth] = useState(process.stdout.columns || 80)
  const [terminalHeight, setTerminalHeight] = useState(process.stdout.rows || 24)
  const [lyricVisualPosition, setLyricVisualPosition] = useState(0)
  const qrTimer = useRef<NodeJS.Timeout | undefined>(undefined)
  const deleteTimer = useRef<NodeJS.Timeout | undefined>(undefined)
  const controlBusy = useRef(false)
  const statusRef = useRef<PlaybackStatus>(emptyStatus)
  const seekTarget = useRef<number | null>(null)
  const seekTimer = useRef<NodeJS.Timeout | undefined>(undefined)
  const seekInFlight = useRef(false)
  const completeExitInProgress = useRef(false)
  const spectrumTarget = useRef<SpectrumFrame>({
    position: 0,
    bins: new Array(64).fill(0),
    peak: 0,
  })
  const lyricClockSample = useRef({
    position: 0,
    receivedAt: Date.now(),
    state: emptyStatus.state,
    duration: 0,
    songId: undefined as number | undefined,
  })

  const updateStatus = (nextStatus: PlaybackStatus) => {
    const previousSample = lyricClockSample.current
    const sameSong = previousSample.songId === nextStatus.song?.id
    const positionJump = Math.abs(nextStatus.position - previousSample.position) > 0.5
    if (!sameSong || positionJump) {
      spectrumTarget.current = {
        position: nextStatus.position,
        bins: new Array(64).fill(0),
        peak: 0,
        generation: nextStatus.spectrumGeneration,
      }
    }
    lyricClockSample.current = {
      position: nextStatus.position,
      receivedAt: Date.now(),
      state: nextStatus.state,
      duration: nextStatus.duration,
      songId: nextStatus.song?.id,
    }
    statusRef.current = nextStatus
    if (!canRenderTerminalFrame(process.stdout)) return
    setLyricVisualPosition((current) =>
      !sameSong || positionJump || nextStatus.state !== 'playing'
        ? nextStatus.position
        : Math.max(current, nextStatus.position),
    )
    setStatus(nextStatus)
  }

  useEffect(() => {
    const timer = setInterval(() => {
      if (!canRenderTerminalFrame(process.stdout)) return
      const sample = lyricClockSample.current
      if (sample.state === 'playing') {
        const elapsed = Math.min(0.14, Math.max(0, (Date.now() - sample.receivedAt) / 1000))
        const position = Math.min(sample.duration || Infinity, sample.position + elapsed)
        setLyricVisualPosition((current) =>
          Math.abs(current - position) < 0.001 ? current : position,
        )
      }

      const target = spectrumTarget.current
      const currentStatus = statusRef.current
      const synchronized = isSpectrumFrameSynchronized(
        target.position,
        currentStatus.position,
        target.generation,
        currentStatus.spectrumGeneration,
      )
      const desiredBins =
        currentStatus.state === 'playing' && synchronized
          ? target.bins
          : new Array(target.bins.length).fill(0)
      setSpectrum((current) => {
        const bins = smoothSpectrumBins(current.bins, desiredBins)
        if (bins.every((value, index) => Math.abs(value - (current.bins[index] || 0)) < 0.001)) {
          return current
        }
        const peak = bins.reduce((maximum, value) => Math.max(maximum, value), 0)
        return { position: target.position, bins, peak, generation: target.generation }
      })
    }, TUI_FRAME_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const runControl = (method: string, params?: Record<string, unknown>) => {
    if (controlBusy.current) return
    controlBusy.current = true
    void callDaemon<PlaybackStatus>(method, params)
      .then((result) => {
        if (result?.daemon === 'running') updateStatus(result)
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        controlBusy.current = false
      })
  }

  const quitCompletely = () => {
    if (completeExitInProgress.current) return
    completeExitInProgress.current = true
    setMessage('正在关闭播放器、后台服务和媒体进程…')
    void callDaemon('shutdown')
      .then(() => exit())
      .catch((error) => {
        completeExitInProgress.current = false
        setMessage(error instanceof Error ? error.message : String(error))
      })
  }

  const commitSeek = async () => {
    if (seekInFlight.current || seekTarget.current === null) return
    const target = seekTarget.current
    seekTarget.current = null
    seekInFlight.current = true
    try {
      const result = await callDaemon<PlaybackStatus>('seek', { value: target, relative: false })
      updateStatus(result)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      seekInFlight.current = false
      if (seekTarget.current !== null) {
        if (seekTimer.current) clearTimeout(seekTimer.current)
        seekTimer.current = setTimeout(() => void commitSeek(), 80)
      }
    }
  }

  const previewSeek = (delta: number) => {
    const current = statusRef.current
    if (!current.song || current.duration <= 0) return
    const base = seekTarget.current ?? current.position
    const target = Math.max(0, Math.min(current.duration, base + delta))
    seekTarget.current = target
    updateStatus({ ...current, position: target })
    setMessage(`跳转到 ${formatTime(target)}`)
    if (seekTimer.current) clearTimeout(seekTimer.current)
    seekTimer.current = setTimeout(() => void commitSeek(), 220)
  }

  const refreshQueue = async () => {
    try {
      const result = await callDaemon<QueueSnapshot>('queue.list')
      if (!canRenderTerminalFrame(process.stdout)) return
      setQueue(result)
      setQueueIndex((index) => Math.max(0, Math.min(index, result.songs.length - 1)))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const verifyAccount = async () => {
    try {
      const result = await callDaemon<AccountStatus>('login.status')
      setAccount(result)
      setMessage(result.loggedIn ? `账号有效：${result.profile?.nickname}` : '当前未登录')
    } catch (error) {
      setAccount({ loggedIn: false, valid: false })
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    const resize = () => {
      setTerminalWidth(process.stdout.columns || 80)
      setTerminalHeight(process.stdout.rows || 24)
    }
    const renderLatestAfterDrain = () => {
      const latest = statusRef.current
      setStatus(latest)
      setLyricVisualPosition(latest.position)
    }
    process.stdout.on('resize', resize)
    process.stdout.on('drain', renderLatestAfterDrain)
    void verifyAccount()
    void refreshQueue()
    const queueTimer = setInterval(() => void refreshQueue(), 2000)
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let reconnectTimer: NodeJS.Timeout | undefined
    const connectSubscription = async () => {
      if (disposed) return
      try {
        unsubscribe = await subscribeDaemon(
          (event) => {
            if (event.event === 'status') {
              const incoming = event.data as PlaybackStatus
              if (seekInFlight.current || seekTarget.current !== null) {
                const position = seekTarget.current ?? statusRef.current.position
                updateStatus({ ...incoming, position })
              } else {
                updateStatus(incoming)
              }
            }
            if (
              event.event === 'spectrum' &&
              !seekInFlight.current &&
              seekTarget.current === null
            ) {
              spectrumTarget.current = event.data as SpectrumFrame
            }
          },
          () => {
            if (!disposed) reconnectTimer = setTimeout(() => void connectSubscription(), 500)
          },
        )
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error))
        if (!disposed) reconnectTimer = setTimeout(() => void connectSubscription(), 1000)
      }
    }
    void connectSubscription()
    return () => {
      disposed = true
      process.stdout.off('resize', resize)
      process.stdout.off('drain', renderLatestAfterDrain)
      clearInterval(queueTimer)
      unsubscribe?.()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (seekTimer.current) clearTimeout(seekTimer.current)
      if (qrTimer.current) clearInterval(qrTimer.current)
      if (deleteTimer.current) clearTimeout(deleteTimer.current)
    }
  }, [])

  useEffect(() => {
    if (mode !== 'classlink') return
    const timer = setInterval(() => {
      void callDaemon<ClassLinkStatus>('classlink.status')
        .then(setClassLinkStatus)
        .catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [mode])

  const submitSearch = async () => {
    const keywords = inputValue.trim()
    if (!keywords) return
    setMessage(`正在搜索：${keywords}`)
    try {
      setSelectedIndex(0)
      if (searchType === 'song') {
        const result = await callDaemon<{ songs: Song[] }>('search', { keywords, limit: 20 })
        setSearchResults(result.songs)
        setMode('results')
        setMessage(result.songs.length ? `找到 ${result.songs.length} 首歌曲` : '没有搜索结果')
      } else if (searchType === 'playlist') {
        const result = await callDaemon<{ items: PlaylistSummary[] }>('search.playlists', {
          keywords,
          limit: 20,
        })
        setSearchPlaylists(result.items)
        setMode('search-playlists')
        setMessage(result.items.length ? `找到 ${result.items.length} 个歌单` : '没有搜索结果')
      } else {
        const result = await callDaemon<{ items: CollectionSummary[] }>(
          searchType === 'album' ? 'search.albums' : 'search.artists',
          { keywords, limit: 20 },
        )
        setSearchCollections(result.items)
        setSearchCollectionType(searchType)
        setMode('search-collections')
        setMessage(
          result.items.length
            ? `找到 ${result.items.length} 个${searchType === 'album' ? '专辑' : '歌手'}`
            : '没有搜索结果',
        )
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const playSearchResult = async (index: number) => {
    const song = searchResults[index]
    if (!song) return
    setMessage(`正在加载搜索队列：${songLabel(song)}`)
    try {
      await callDaemon('queue.replace', {
        ids: searchResults.map((item) => item.id),
        index,
        context: 'search',
        name: inputValue.trim() || '搜索结果',
      })
      await refreshQueue()
      setMode('normal')
      setMessage(`正在播放：${songLabel(song)}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const enqueueSong = async (song: Song, next: boolean) => {
    try {
      await callDaemon(next ? 'queue.next' : 'queue.add', { id: song.id })
      await refreshQueue()
      setMessage(`${next ? '下一首播放' : '已加入队列'}：${songLabel(song)}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const showComments = async (
    method: 'comments.song' | 'comments.playlist',
    params: Record<string, unknown>,
    title: string,
    returnMode: PageMode,
  ) => {
    setMessage(`正在加载${title}…`)
    try {
      const result = await callDaemon<CommentPage>(method, { ...params, limit: 30, offset: 0 })
      const seen = new Set<number>()
      const rows = [...result.hotComments, ...result.comments].filter((comment) => {
        if (seen.has(comment.id)) return false
        seen.add(comment.id)
        return true
      })
      setComments(rows)
      setCommentIndex(0)
      setCommentTitle(title)
      setCommentTotal(result.total)
      setCommentReturnMode(returnMode)
      setMode('comments')
      setMessage(`${title} · ${result.total} 条`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const togglePlaylistSubscription = async (playlist: PlaylistSummary) => {
    if (playlist.creator?.id === account.profile?.userId) {
      setMessage('自建歌单无需收藏，不能在这里取消')
      return
    }
    const subscribed = !playlist.subscribed
    try {
      await callDaemon('library.playlist.subscribe', { id: playlist.id, subscribed })
      setPlaylists((items) =>
        items.map((item) => (item.id === playlist.id ? { ...item, subscribed } : item)),
      )
      setSearchPlaylists((items) =>
        items.map((item) => (item.id === playlist.id ? { ...item, subscribed } : item)),
      )
      setMessage(`${subscribed ? '已收藏' : '已取消收藏'}：${playlist.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openPlaylistPicker = async (song: Song, returnMode: PageMode) => {
    setMessage('正在加载自建歌单…')
    try {
      const result = await callDaemon<PlaylistSummary[]>('library.playlists')
      const owned = result.filter((playlist) => playlist.creator?.id === account.profile?.userId)
      if (!owned.length) {
        setMessage('没有可添加歌曲的自建歌单，请先创建歌单')
        return
      }
      setPlaylists(owned)
      setPlaylistPickerSong(song)
      setPlaylistPickerReturnMode(returnMode)
      setLibraryIndex(0)
      setMode('playlist-picker')
      setMessage(`选择要加入的歌单：${songLabel(song)}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const submitPlaylistEdit = async () => {
    const name = inputValue.trim()
    if (!name) return
    try {
      if (playlistEditAction === 'create') {
        await callDaemon('library.playlist.create', { name })
        setMessage(`已创建歌单：${name}`)
      } else if (playlistEditTarget) {
        await callDaemon('library.playlist.rename', { id: playlistEditTarget.id, name })
        setMessage(`歌单已重命名为：${name}`)
      }
      const result = await callDaemon<PlaylistSummary[]>('library.playlists')
      setPlaylists(result)
      setLibraryIndex(0)
      setInputValue('')
      setMode('playlists')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteOwnedPlaylist = async (playlist: PlaylistSummary) => {
    if (playlist.creator?.id !== account.profile?.userId) {
      setMessage('只能删除自己的歌单')
      return
    }
    if (deleteArmedId !== playlist.id) {
      setDeleteArmedId(playlist.id)
      if (deleteTimer.current) clearTimeout(deleteTimer.current)
      deleteTimer.current = setTimeout(() => setDeleteArmedId(null), 4000)
      setMessage(`再次按 Shift+D 确认删除：${playlist.name}`)
      return
    }
    try {
      await callDaemon('library.playlist.delete', { id: playlist.id })
      const result = playlists.filter((item) => item.id !== playlist.id)
      setPlaylists(result)
      setLibraryIndex((index) => Math.max(0, Math.min(index, result.length - 1)))
      setDeleteArmedId(null)
      setMessage(`已删除歌单：${playlist.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const addSongToPickedPlaylist = async () => {
    const playlist = playlists[libraryIndex]
    const song = playlistPickerSong
    if (!playlist || !song) return
    try {
      await callDaemon('library.playlist.tracks', {
        id: playlist.id,
        trackIds: [song.id],
        operation: 'add',
      })
      setMode(playlistPickerReturnMode)
      setMessage(`已将「${song.name}」加入：${playlist.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const removeTrackFromOwnedPlaylist = async (song: Song) => {
    if (librarySource?.type !== 'playlist' || !librarySource.owned) return
    try {
      await callDaemon('library.playlist.tracks', {
        id: librarySource.id,
        trackIds: [song.id],
        operation: 'del',
      })
      setLibrarySongs((items) => items.filter((item) => item.id !== song.id))
      setLibraryIndex((index) => Math.max(0, Math.min(index, librarySongs.length - 2)))
      setMessage(`已从歌单移除：${songLabel(song)}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openPlaylists = async () => {
    setMessage('正在加载账号歌单…')
    try {
      const result = await callDaemon<PlaylistSummary[]>('library.playlists')
      setPlaylists(result)
      setPlaylistPageTitle('我的歌单')
      setPlaylistPageKind('library')
      setLibraryIndex(0)
      setMode('playlists')
      setMessage(`已加载 ${result.length} 个歌单`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openPlaylist = async (playlist: PlaylistSummary, returnMode: PageMode = 'playlists') => {
    setMessage(`正在加载歌单：${playlist.name}…`)
    try {
      const result = await callDaemon<{ playlist: PlaylistSummary; songs: Song[] }>(
        'library.playlist',
        { id: playlist.id },
      )
      setLibrarySongs(result.songs)
      setLibrarySource({
        type: 'playlist',
        id: playlist.id,
        name: playlist.name,
        owned: playlist.creator?.id === account.profile?.userId,
      })
      setTrackReturnMode(returnMode)
      setLibraryIndex(0)
      setMode('tracks')
      setMessage(`${playlist.name} · ${result.songs.length} 首歌曲`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openDaily = async () => {
    setMessage('正在加载每日推荐…')
    try {
      const songs = await callDaemon<Song[]>('library.daily')
      setLibrarySongs(songs)
      setLibrarySource({ type: 'daily', name: '每日推荐' })
      setTrackReturnMode('library')
      setLibraryIndex(0)
      setMode('tracks')
      setMessage(`每日推荐 · ${songs.length} 首歌曲`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openDailyPlaylists = async () => {
    setMessage('正在加载每日推荐歌单…')
    try {
      const result = await callDaemon<PlaylistSummary[]>('library.daily.playlists')
      setPlaylists(result)
      setPlaylistPageTitle('每日推荐歌单')
      setPlaylistPageKind('daily')
      setLibraryIndex(0)
      setMode('playlists')
      setMessage(`每日推荐歌单 · ${result.length} 个`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openDiscoverPlaylists = async (entry: (typeof discoverEntries)[number]) => {
    setMessage(`正在加载${entry.name}歌单…`)
    try {
      let result: PlaylistSummary[]
      if (entry.kind === 'recommended') {
        result = await callDaemon<PlaylistSummary[]>('library.discover.recommended', { limit: 30 })
      } else {
        const response = await callDaemon<{ playlists: PlaylistSummary[] }>(
          entry.kind === 'highquality'
            ? 'library.discover.highquality'
            : 'library.discover.playlists',
          { cat: entry.kind === 'category' ? entry.name : '全部', limit: 50 },
        )
        result = response.playlists
      }
      setPlaylists(result)
      setPlaylistPageTitle(entry.name === '全部' ? '热门歌单' : entry.name)
      setPlaylistPageKind('discover')
      setLibraryIndex(0)
      setMode('playlists')
      setMessage(`${entry.name} · ${result.length} 个歌单`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openToplists = async () => {
    setMessage('正在加载网易云官方榜单…')
    try {
      const result = await callDaemon<PlaylistSummary[]>('library.toplists')
      setPlaylists(result)
      setPlaylistPageTitle('网易云官方榜单')
      setPlaylistPageKind('toplist')
      setLibraryIndex(0)
      setMode('playlists')
      setMessage(`官方榜单 · ${result.length} 个`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openToplist = async (toplist: PlaylistSummary) => {
    setMessage(`正在加载榜单：${toplist.name}…`)
    try {
      const result = await callDaemon<{ playlist: PlaylistSummary; songs: Song[] }>(
        'library.toplist',
        { id: toplist.id },
      )
      setLibrarySongs(result.songs)
      setLibrarySource({ type: 'toplist', id: toplist.id, name: toplist.name })
      setTrackReturnMode('playlists')
      setLibraryIndex(0)
      setMode('tracks')
      setMessage(`${toplist.name} · ${result.songs.length} 首歌曲`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openNewSongs = async (area: number, name: string) => {
    setMessage(`正在加载${name}…`)
    try {
      const result = await callDaemon<{ area: number; name: string; songs: Song[] }>(
        'library.new',
        {
          area,
        },
      )
      setLibrarySongs(result.songs)
      setLibrarySource({ type: 'new', area: result.area, name: result.name })
      setTrackReturnMode('new-regions')
      setLibraryIndex(0)
      setMode('tracks')
      setMessage(`${result.name} · ${result.songs.length} 首歌曲`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openHistory = async () => {
    setMessage('正在加载最近播放…')
    try {
      const entries = await callDaemon<HistoryEntry[]>('library.history')
      setLibrarySongs(entries.map((entry) => entry.song))
      setLibrarySource({ type: 'history', name: '最近播放' })
      setTrackReturnMode('library')
      setLibraryIndex(0)
      setMode('tracks')
      setMessage(`最近播放 · ${entries.length} 首歌曲`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openCloud = async () => {
    setMessage('正在加载音乐云盘…')
    try {
      const cloud = await callDaemon<CloudLibrary>('library.cloud')
      setLibrarySongs(cloud.songs)
      setLibrarySource({ type: 'cloud', name: '音乐云盘' })
      setTrackReturnMode('library')
      setLibraryIndex(0)
      setMode('tracks')
      const usage =
        cloud.maxSize > 0 ? ` · ${Math.round((cloud.size / cloud.maxSize) * 100)}% 已用` : ''
      setMessage(`音乐云盘 · ${cloud.songs.length} 首${usage}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openCollections = async (type: 'album' | 'artist') => {
    setMessage(type === 'album' ? '正在加载收藏专辑…' : '正在加载关注歌手…')
    try {
      const items = await callDaemon<CollectionSummary[]>(
        type === 'album' ? 'library.albums' : 'library.artists',
      )
      setCollections(items)
      setCollectionType(type)
      setLibraryIndex(0)
      setMode('collections')
      setMessage(`${type === 'album' ? '收藏专辑' : '关注歌手'} · ${items.length} 项`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openListeningRecord = async (range: 'week' | 'all') => {
    const name = range === 'week' ? '本周听歌排行' : '全部听歌排行'
    setMessage(`正在加载${name}…`)
    try {
      const entries = await callDaemon<ListeningRecordEntry[]>('library.record', { range })
      setLibrarySongs(entries.map((entry) => entry.song))
      setLibrarySource({ type: 'record', range, name })
      setTrackReturnMode('library')
      setLibraryIndex(0)
      setMode('tracks')
      setMessage(`${name} · ${entries.length} 首`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openCollection = async (
    collection: CollectionSummary,
    returnMode: PageMode = 'collections',
  ) => {
    setMessage(`正在加载：${collection.name}…`)
    try {
      const result = await callDaemon<{ collection: CollectionSummary; songs: Song[] }>(
        collection.type === 'album' ? 'library.album' : 'library.artist',
        { id: collection.id },
      )
      setLibrarySongs(result.songs)
      setLibrarySource({ type: collection.type, id: collection.id, name: collection.name })
      setTrackReturnMode(returnMode)
      setLibraryIndex(0)
      setMode('tracks')
      setMessage(`${collection.name} · ${result.songs.length} 首歌曲`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const playLibrary = async (index: number) => {
    if (!librarySource || !librarySongs[index]) return
    setMessage(`正在加载：${songLabel(librarySongs[index])}`)
    try {
      if (librarySource.type === 'playlist') {
        await callDaemon('library.playlist.play', { id: librarySource.id, index })
      } else if (librarySource.type === 'daily') {
        await callDaemon('library.daily.play', { index })
      } else if (librarySource.type === 'history') {
        await callDaemon('library.history.play', { index })
      } else if (librarySource.type === 'cloud') {
        await callDaemon('library.cloud.play', { index })
      } else if (librarySource.type === 'album') {
        await callDaemon('library.album.play', { id: librarySource.id, index })
      } else if (librarySource.type === 'artist') {
        await callDaemon('library.artist.play', { id: librarySource.id, index })
      } else if (librarySource.type === 'record') {
        await callDaemon('library.record.play', { range: librarySource.range, index })
      } else if (librarySource.type === 'toplist') {
        await callDaemon('library.toplist.play', { id: librarySource.id, index })
      } else if (librarySource.type === 'new') {
        await callDaemon('library.new.play', { area: librarySource.area, index })
      }
      await refreshQueue()
      setMode('normal')
      setMessage(`正在播放：${librarySource.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const playFm = async () => {
    setMessage('正在加载私人 FM…')
    try {
      await callDaemon('library.fm.play')
      await refreshQueue()
      setMode('normal')
      setMessage('私人 FM 已开始播放')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const playHeartMode = async () => {
    setMessage('正在生成心动模式智能队列…')
    try {
      await callDaemon('library.heart.play')
      await refreshQueue()
      setMode('normal')
      setMessage('已进入心动模式')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const refreshSettingsState = async () => {
    const [config, linkStatus] = await Promise.all([
      callDaemon<AppConfig>('config.get'),
      callDaemon<ClassLinkStatus>('classlink.status'),
    ])
    setSettingsConfig(config)
    setClassLinkStatus(linkStatus)
    return { config, linkStatus }
  }

  const openSettings = async () => {
    setMessage('正在加载设置…')
    try {
      await refreshSettingsState()
      setSettingsIndex(0)
      setMode('settings')
      setMessage('设置会立即保存并应用')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openClassLinkPage = async () => {
    setClassLinkIndex(0)
    setMode('classlink')
    setMessage('正在加载 ClassLink 状态…')
    try {
      const { linkStatus } = await refreshSettingsState()
      setMessage(linkStatus.connected ? 'ClassLink 已连接到 ClassIsland' : 'ClassLink 设置已加载')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openAccountPage = async () => {
    setAccountIndex(0)
    setMode('account')
    setMessage('正在加载网易云账号资料…')
    try {
      const status = await callDaemon<AccountStatus>('login.status')
      setAccount(status)
      if (status.loggedIn) {
        const profile = await callDaemon<UserProfile>('library.profile')
        setAccountProfile(profile)
        setMessage(`账号资料已更新：${profile.nickname}`)
      } else {
        setAccountProfile(null)
        setMessage('当前未登录')
      }
    } catch (error) {
      setAccountProfile(null)
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const changeSetting = async (index: number, direction = 1) => {
    if (!settingsConfig) return
    try {
      if (index === 5) {
        await callDaemon('smtc.set', { enabled: !settingsConfig.smtc.enabled })
      } else {
        let patch: Partial<AppConfig> = {}
        if (index === 0) {
          patch = {
            scrobble: {
              ...settingsConfig.scrobble,
              enabled: !settingsConfig.scrobble.enabled,
              configured: true,
            },
          }
        }
        if (index === 1) {
          patch = {
            scrobble: {
              ...settingsConfig.scrobble,
              mode: settingsConfig.scrobble.mode === 'ncbl' ? 'legacy' : 'ncbl',
              configured: true,
            },
          }
        }
        if (index === 2) {
          const levels = ['standard', 'higher', 'exhigh', 'lossless', 'hires']
          const current = Math.max(0, levels.indexOf(settingsConfig.quality))
          patch = { quality: levels[(current + direction + levels.length) % levels.length] }
        }
        if (index === 3) {
          patch = {
            unblock: { ...settingsConfig.unblock, enabled: !settingsConfig.unblock.enabled },
          }
        }
        if (index === 4) patch = { allowTrial: !settingsConfig.allowTrial }
        if (index === 6) {
          patch = {
            lyrics: { ...settingsConfig.lyrics, upgrade: !settingsConfig.lyrics.upgrade },
          }
        }
        await callDaemon('config.set', { patch })
      }
      await refreshSettingsState()
      setMessage('设置已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const changeClassLinkSetting = async (index: number) => {
    if (!settingsConfig || !classLinkStatus) return
    if (index === 1) {
      setInputValue(String(settingsConfig.classLink.port))
      setMode('classlink-port')
      setMessage('输入 ClassIsland 插件的监听端口')
      return
    }
    if (index === 2) {
      setInputValue('')
      setMode('classlink-token')
      setMessage('连接令牌只会保存到敏感配置，不会回显')
      return
    }
    try {
      if (index === 0) {
        if (!classLinkStatus.configured && !classLinkStatus.enabled) {
          setInputValue('')
          setMode('classlink-token')
          setMessage('请先输入 ClassIsland 插件生成的连接令牌')
          return
        }
        setClassLinkStatus(
          await callDaemon<ClassLinkStatus>('classlink.set', {
            enabled: !classLinkStatus.enabled,
          }),
        )
      }
      if (index === 3) {
        if (!classLinkStatus.configured) {
          setMessage('当前没有已保存的 ClassLink 令牌')
          return
        }
        setClassLinkStatus(
          await callDaemon<ClassLinkStatus>('classlink.set', {
            enabled: false,
            clearToken: true,
          }),
        )
      }
      await refreshSettingsState()
      setMessage(index === 3 ? 'ClassLink 已断开并删除连接令牌' : 'ClassLink 设置已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const submitClassLinkToken = async () => {
    const token = inputValue.trim()
    setInputValue('')
    if (!token) {
      setMessage('ClassLink 连接令牌不能为空')
      return
    }
    setMessage('正在保存并连接 ClassLink…')
    try {
      setClassLinkStatus(
        await callDaemon<ClassLinkStatus>('classlink.set', { token, enabled: true }),
      )
      await refreshSettingsState()
      setMode('classlink')
      setMessage('ClassLink 令牌已保存，正在连接 ClassIsland')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const submitClassLinkPort = async () => {
    const port = Number(inputValue)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setMessage('端口必须是 1024 到 65535 之间的整数')
      return
    }
    setInputValue('')
    try {
      setClassLinkStatus(await callDaemon<ClassLinkStatus>('classlink.set', { port }))
      await refreshSettingsState()
      setMode('classlink')
      setMessage(`ClassLink 端口已更新为 ${port}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const submitCookie = async () => {
    const cookie = inputValue.trim()
    setInputValue('')
    if (!cookie) return
    setMessage('正在验证 Cookie 对应的网易云账号…')
    try {
      const result = await callDaemon<{
        profile: { userId: number; nickname: string; vipType: number }
      }>('login.cookie', { cookie })
      setAccount({ loggedIn: true, valid: true, profile: result.profile })
      setMode('account')
      setMessage(`登录成功：${result.profile.nickname}，Cookie 已保存`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const beginQrLogin = async () => {
    setMessage('正在生成登录二维码…')
    try {
      const result = await callDaemon<{ key: string; url: string }>('login.qr.start')
      qrcode.generate(result.url, { small: true }, (code) => setQrText(code))
      setMode('qr')
      setMessage('请使用网易云音乐 App 扫码确认')
      if (qrTimer.current) clearInterval(qrTimer.current)
      qrTimer.current = setInterval(async () => {
        try {
          const check = await callDaemon<{
            code: number
            loggedIn: boolean
            profile?: AccountStatus['profile']
          }>('login.qr.check', { key: result.key })
          if (check.loggedIn) {
            if (qrTimer.current) clearInterval(qrTimer.current)
            setAccount({ loggedIn: true, valid: true, profile: check.profile })
            setMode('account')
            setQrText('')
            setMessage(`登录成功：${check.profile?.nickname || '网易云用户'}`)
          } else if (check.code === 800) {
            if (qrTimer.current) clearInterval(qrTimer.current)
            setMode('account')
            setQrText('')
            setMessage('二维码已过期，请在账号设置中重新生成')
          }
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, 2000)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  useInput((input, key) => {
    const controlInput = normalizeControlInput(input)

    if (mode === 'playlist-edit') {
      if (key.escape) {
        setInputValue('')
        setMode('playlists')
        return
      }
      if (key.return) {
        void submitPlaylistEdit()
        return
      }
      if (key.backspace || key.delete) {
        setInputValue((value) => value.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) setInputValue((value) => value + input)
      return
    }

    if (mode === 'classlink-token' || mode === 'classlink-port') {
      if (key.escape) {
        setInputValue('')
        setMode('classlink')
        return
      }
      if (key.return) {
        void (mode === 'classlink-token' ? submitClassLinkToken() : submitClassLinkPort())
        return
      }
      if (key.backspace || key.delete) {
        setInputValue((value) => value.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta && (mode === 'classlink-token' || /^\d+$/.test(input))) {
        setInputValue((value) => value + input)
      }
      return
    }

    if (mode === 'search' || mode === 'cookie') {
      if (key.escape) {
        setInputValue('')
        setMode(mode === 'cookie' ? 'account' : 'normal')
        return
      }
      if (key.return) {
        void (mode === 'search' ? submitSearch() : submitCookie())
        return
      }
      if (mode === 'search' && key.tab) {
        const index = searchTypes.indexOf(searchType)
        setSearchType(searchTypes[(index + 1) % searchTypes.length] || 'song')
        return
      }
      if (key.backspace || key.delete) {
        setInputValue((value) => value.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) setInputValue((value) => value + input)
      return
    }

    if (mode === 'results') {
      if (key.escape) return setMode('normal')
      if (input === '/') {
        setInputValue('')
        return setMode('search')
      }
      if (key.upArrow) return setSelectedIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) {
        return setSelectedIndex((index) => Math.min(searchResults.length - 1, index + 1))
      }
      if (key.return && searchResults[selectedIndex]) void playSearchResult(selectedIndex)
      if (controlInput === 'n' && searchResults[selectedIndex]) {
        void enqueueSong(searchResults[selectedIndex], true)
      }
      if (controlInput === 'e' && searchResults[selectedIndex]) {
        void enqueueSong(searchResults[selectedIndex], false)
      }
      if (controlInput === 's' && searchResults[selectedIndex]) {
        void openPlaylistPicker(searchResults[selectedIndex], 'results')
      }
      return
    }

    if (mode === 'search-playlists') {
      if (key.escape) return setMode('normal')
      if (input === '/') {
        setInputValue('')
        return setMode('search')
      }
      if (key.upArrow) return setSelectedIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) {
        return setSelectedIndex((index) => Math.min(searchPlaylists.length - 1, index + 1))
      }
      if (key.return && searchPlaylists[selectedIndex]) {
        void openPlaylist(searchPlaylists[selectedIndex], 'search-playlists')
      }
      if (controlInput === 'f' && searchPlaylists[selectedIndex]) {
        void togglePlaylistSubscription(searchPlaylists[selectedIndex])
      }
      return
    }

    if (mode === 'search-collections') {
      if (key.escape) return setMode('normal')
      if (input === '/') {
        setInputValue('')
        return setMode('search')
      }
      if (key.upArrow) return setSelectedIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) {
        return setSelectedIndex((index) => Math.min(searchCollections.length - 1, index + 1))
      }
      if (key.return && searchCollections[selectedIndex]) {
        void openCollection(searchCollections[selectedIndex], 'search-collections')
      }
      return
    }

    if (mode === 'queue') {
      if (key.escape || key.tab) return setMode('normal')
      if (key.upArrow) return setQueueIndex((index) => Math.max(0, index - 1))
      if (key.downArrow)
        return setQueueIndex((index) => Math.min(queue.songs.length - 1, index + 1))
      if (key.return && queue.songs[queueIndex]) {
        const selectedSong = queue.songs[queueIndex]
        void callDaemon('queue.play', { index: queueIndex })
          .then(() => {
            setMode('normal')
            setMessage(`正在播放：${songLabel(selectedSong)}`)
          })
          .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      }
      if (controlInput === 'x' && queue.songs[queueIndex]) {
        const removed = queue.songs[queueIndex]
        void callDaemon<QueueSnapshot>('queue.remove', { index: queueIndex })
          .then((result) => {
            setQueue(result)
            setQueueIndex(Math.max(0, Math.min(queueIndex, result.songs.length - 1)))
            setMessage(`已从队列移除：${songLabel(removed)}`)
          })
          .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      }
      if ((input === '[' || input === ']') && queue.songs[queueIndex]) {
        const target = Math.max(
          0,
          Math.min(queue.songs.length - 1, queueIndex + (input === '[' ? -1 : 1)),
        )
        if (target !== queueIndex) {
          void callDaemon<QueueSnapshot>('queue.move', { from: queueIndex, to: target })
            .then((result) => {
              setQueue(result)
              setQueueIndex(target)
              setMessage('已调整队列顺序')
            })
            .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
        }
      }
      if (input === 'C' && queue.songs.length) {
        void callDaemon<QueueSnapshot>('queue.clear')
          .then((result) => {
            setQueue(result)
            setQueueIndex(0)
            setMessage('播放队列已清空')
          })
          .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      }
      return
    }

    if (mode === 'library') {
      if (key.escape || controlInput === 'l') return setMode('normal')
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) return setLibraryIndex((index) => Math.min(13, index + 1))
      if (key.return) {
        if (libraryIndex === 0) void openPlaylists()
        if (libraryIndex === 1) void openDaily()
        if (libraryIndex === 2) void openDailyPlaylists()
        if (libraryIndex === 3) {
          setLibraryIndex(0)
          setMode('discover-categories')
        }
        if (libraryIndex === 4) void openToplists()
        if (libraryIndex === 5) {
          setLibraryIndex(0)
          setMode('new-regions')
        }
        if (libraryIndex === 6) void playFm()
        if (libraryIndex === 7) void playHeartMode()
        if (libraryIndex === 8) void openHistory()
        if (libraryIndex === 9) void openCloud()
        if (libraryIndex === 10) void openCollections('album')
        if (libraryIndex === 11) void openCollections('artist')
        if (libraryIndex === 12) void openListeningRecord('week')
        if (libraryIndex === 13) void openListeningRecord('all')
      }
      return
    }

    if (mode === 'discover-categories') {
      if (key.escape) return setMode('library')
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) {
        return setLibraryIndex((index) => Math.min(discoverEntries.length - 1, index + 1))
      }
      if (key.return && discoverEntries[libraryIndex]) {
        void openDiscoverPlaylists(discoverEntries[libraryIndex])
      }
      return
    }

    if (mode === 'new-regions') {
      if (key.escape) return setMode('library')
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) {
        return setLibraryIndex((index) => Math.min(newSongRegions.length - 1, index + 1))
      }
      if (key.return && newSongRegions[libraryIndex]) {
        const region = newSongRegions[libraryIndex]
        void openNewSongs(region.area, region.name)
      }
      return
    }

    if (mode === 'playlists') {
      if (key.escape) return setMode('library')
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow)
        return setLibraryIndex((index) => Math.min(playlists.length - 1, index + 1))
      if (key.return && playlists[libraryIndex]) {
        if (playlistPageKind === 'toplist') void openToplist(playlists[libraryIndex])
        else void openPlaylist(playlists[libraryIndex])
      }
      if (controlInput === 'f' && playlistPageKind !== 'toplist' && playlists[libraryIndex]) {
        void togglePlaylistSubscription(playlists[libraryIndex])
      }
      if (controlInput === 'c' && playlistPageKind === 'library') {
        setPlaylistEditAction('create')
        setPlaylistEditTarget(null)
        setInputValue('')
        setMode('playlist-edit')
      }
      if (input === 'R' && playlistPageKind === 'library' && playlists[libraryIndex]) {
        const playlist = playlists[libraryIndex]
        if (playlist.creator?.id !== account.profile?.userId) {
          setMessage('只能重命名自己的歌单')
        } else {
          setPlaylistEditAction('rename')
          setPlaylistEditTarget(playlist)
          setInputValue(playlist.name)
          setMode('playlist-edit')
        }
      }
      if (input === 'D' && playlistPageKind === 'library' && playlists[libraryIndex]) {
        void deleteOwnedPlaylist(playlists[libraryIndex])
      }
      return
    }

    if (mode === 'playlist-picker') {
      if (key.escape) return setMode(playlistPickerReturnMode)
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) {
        return setLibraryIndex((index) => Math.min(playlists.length - 1, index + 1))
      }
      if (key.return) void addSongToPickedPlaylist()
      return
    }

    if (mode === 'collections') {
      if (key.escape) return setMode('library')
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow)
        return setLibraryIndex((index) => Math.min(collections.length - 1, index + 1))
      if (key.return && collections[libraryIndex]) void openCollection(collections[libraryIndex])
      return
    }

    if (mode === 'tracks') {
      if (key.escape) return setMode(trackReturnMode)
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow)
        return setLibraryIndex((index) => Math.min(librarySongs.length - 1, index + 1))
      if (key.return && librarySongs[libraryIndex]) void playLibrary(libraryIndex)
      if (controlInput === 'a' && librarySongs.length) void playLibrary(0)
      if (controlInput === 'n' && librarySongs[libraryIndex]) {
        void enqueueSong(librarySongs[libraryIndex], true)
      }
      if (controlInput === 'e' && librarySongs[libraryIndex]) {
        void enqueueSong(librarySongs[libraryIndex], false)
      }
      if (controlInput === 's' && librarySongs[libraryIndex]) {
        void openPlaylistPicker(librarySongs[libraryIndex], 'tracks')
      }
      if (
        controlInput === 'x' &&
        librarySongs[libraryIndex] &&
        librarySource?.type === 'playlist' &&
        librarySource.owned
      ) {
        void removeTrackFromOwnedPlaylist(librarySongs[libraryIndex])
      }
      if (controlInput === 'r' && librarySource?.type === 'playlist') {
        void showComments(
          'comments.playlist',
          { id: librarySource.id },
          `${librarySource.name} · 歌单评论`,
          'tracks',
        )
      }
      return
    }

    if (mode === 'comments') {
      if (key.escape) return setMode(commentReturnMode)
      if (key.upArrow) return setCommentIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) {
        return setCommentIndex((index) => Math.min(Math.max(0, comments.length - 1), index + 1))
      }
      return
    }

    if (mode === 'settings') {
      if (key.escape || controlInput === 'o' || input === ',') return setMode('normal')
      if (key.upArrow) return setSettingsIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) return setSettingsIndex((index) => Math.min(8, index + 1))
      if (settingsIndex === 7 && (key.rightArrow || key.return || input === ' ')) {
        return void openClassLinkPage()
      }
      if (settingsIndex === 8 && (key.rightArrow || key.return || input === ' ')) {
        return void openAccountPage()
      }
      if (settingsIndex >= 7) return
      if (key.leftArrow) void changeSetting(settingsIndex, -1)
      if (key.rightArrow || key.return || input === ' ') void changeSetting(settingsIndex, 1)
      return
    }

    if (mode === 'classlink') {
      if (key.escape) return setMode('settings')
      if (key.upArrow) return setClassLinkIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) return setClassLinkIndex((index) => Math.min(3, index + 1))
      if (
        (classLinkIndex === 0 && key.leftArrow) ||
        key.rightArrow ||
        key.return ||
        input === ' '
      ) {
        void changeClassLinkSetting(classLinkIndex)
      }
      return
    }

    if (mode === 'account') {
      if (key.escape) return setMode('settings')
      if (key.upArrow) return setAccountIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) return setAccountIndex((index) => Math.min(3, index + 1))
      if (key.return) {
        if (accountIndex === 0) {
          setInputValue('')
          return setMode('cookie')
        }
        if (accountIndex === 1) return void beginQrLogin()
        if (accountIndex === 2) return void verifyAccount()
        if (accountIndex === 3) {
          void callDaemon('logout')
            .then(() => {
              setAccount({ loggedIn: false, valid: false })
              setAccountProfile(null)
              setMessage('已退出网易云账号')
            })
            .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
        }
      }
      return
    }

    if (mode === 'qr') {
      if (key.escape) {
        if (qrTimer.current) clearInterval(qrTimer.current)
        setQrText('')
        setMode('account')
      }
      return
    }

    if (controlInput === 'x') return quitCompletely()
    if (controlInput === 'q' || key.escape) return exit()
    if (input === '/') {
      setInputValue('')
      return setMode('search')
    }
    if (controlInput === 'l') {
      setLibraryIndex(0)
      return setMode('library')
    }
    if (controlInput === 'o' || input === ',') return void openSettings()
    if (controlInput === 's' && status.song) {
      return void openPlaylistPicker(status.song, 'normal')
    }
    if (controlInput === 'r' && status.song) {
      return void showComments(
        'comments.song',
        { id: status.song.id },
        `${status.song.name} · 歌曲评论`,
        'normal',
      )
    }
    if (key.tab) return setMode('queue')
    if (controlInput === 'f' && status.song) {
      runControl('like', { id: status.song.id, liked: !status.liked })
      setMessage(status.liked ? '已取消喜欢' : '已加入喜欢')
    }
    if (controlInput === 'm') {
      const modes: PlaybackMode[] = ['sequence', 'repeat-one', 'shuffle']
      const nextMode = modes[(modes.indexOf(status.mode) + 1) % modes.length]
      runControl('mode.set', { mode: nextMode })
      setMessage(`播放模式：${nextMode}`)
    }
    if (controlInput === 'd' && status.queueContext?.type === 'fm') {
      runControl('library.fm.trash')
      setMessage('已移入 FM 垃圾桶并播放下一首')
    }
    if (input === ' ') runControl('toggle')
    if (controlInput === 'n') runControl('next')
    if (controlInput === 'p') runControl('previous')
    if (key.leftArrow) previewSeek(-5)
    if (key.rightArrow) previewSeek(5)
    if (key.upArrow) runControl('volume', { value: Math.min(100, status.volume + 5) })
    if (key.downArrow) runControl('volume', { value: Math.max(0, status.volume - 5) })
  })

  const artists = status.song?.artists.map((artist) => artist.name).join(' / ') || '—'
  const playerLayout = getPlayerLayout(terminalWidth, terminalHeight)
  const visiblePreviousLyricLines = status.previousLyricLines?.slice(
    playerLayout.expanded ? -2 : -1,
  )
  const visibleUpcomingLyricLines = status.upcomingLyricLines?.slice(
    0,
    playerLayout.expanded ? 3 : 1,
  )
  const currentLineEntrance = status.currentLyricLine
    ? getLyricLineTransition(lyricVisualPosition, status.currentLyricLine.time)
    : 0
  const nextLineEntrance = status.nextLyricLine
    ? getLyricLineTransition(lyricVisualPosition, status.nextLyricLine.time)
    : 0
  const currentLineEmphasis = status.currentLyricLine
    ? Math.min(currentLineEntrance, status.nextLyricLine ? 1 - nextLineEntrance : 1)
    : 0
  const progressWidth = playerLayout.progressWidth
  const visualPosition = Math.max(0, Math.min(status.duration || Infinity, lyricVisualPosition))
  const progress = status.duration ? visualPosition / status.duration : 0
  const progressBar = renderProgressBar(progress, progressWidth)
  const modeLabel: Record<PlaybackMode, string> = {
    sequence: '顺序播放',
    'repeat-one': '单曲循环',
    shuffle: '随机播放',
  }
  const sourceLabel = status.source === 'unblock' ? `解灰 · ${status.sourceName || 'auto'}` : null
  const stateIcon =
    status.state === 'playing'
      ? '▶'
      : status.state === 'paused'
        ? 'Ⅱ'
        : status.state === 'loading'
          ? '◌'
          : '■'
  const resultStart = Math.max(0, Math.min(selectedIndex - 3, searchResults.length - 8))
  const visibleResults = searchResults.slice(resultStart, resultStart + 8)
  const searchPlaylistStart = Math.max(0, Math.min(selectedIndex - 3, searchPlaylists.length - 8))
  const visibleSearchPlaylists = searchPlaylists.slice(searchPlaylistStart, searchPlaylistStart + 8)
  const searchCollectionStart = Math.max(
    0,
    Math.min(selectedIndex - 3, searchCollections.length - 8),
  )
  const visibleSearchCollections = searchCollections.slice(
    searchCollectionStart,
    searchCollectionStart + 8,
  )
  const queueStart = Math.max(0, Math.min(queueIndex - 3, queue.songs.length - 8))
  const visibleQueue = queue.songs.slice(queueStart, queueStart + 8)
  const playlistStart = Math.max(0, Math.min(libraryIndex - 3, playlists.length - 8))
  const visiblePlaylists = playlists.slice(playlistStart, playlistStart + 8)
  const collectionStart = Math.max(0, Math.min(libraryIndex - 3, collections.length - 8))
  const visibleCollections = collections.slice(collectionStart, collectionStart + 8)
  const trackStart = Math.max(0, Math.min(libraryIndex - 3, librarySongs.length - 8))
  const visibleTracks = librarySongs.slice(trackStart, trackStart + 8)
  const commentStart = Math.max(0, Math.min(commentIndex - 2, comments.length - 6))
  const visibleComments = comments.slice(commentStart, commentStart + 6)
  const shownInput = inputValue.slice(-Math.max(12, terminalWidth - 18))
  const settingsRows: Array<[string, string]> = settingsConfig
    ? [
        ['听歌上报', settingsConfig.scrobble.enabled ? '开启' : '关闭'],
        ['上报方式', settingsConfig.scrobble.mode === 'ncbl' ? 'NCBL (PLV/PLD)' : 'Legacy'],
        ['默认音质', settingsConfig.quality],
        ['解灰回退', settingsConfig.unblock.enabled ? '开启' : '关闭'],
        ['官方试听', settingsConfig.allowTrial ? '允许' : '关闭'],
        ['Windows SMTC', settingsConfig.smtc.enabled ? '开启' : '关闭'],
        ['歌词升级', settingsConfig.lyrics.upgrade ? 'TTML / QRC' : '关闭'],
        [
          'ClassLink',
          classLinkStatus?.connected
            ? '已连接'
            : settingsConfig.classLink.enabled
              ? classLinkStatus?.configured
                ? '等待连接'
                : '缺少令牌'
              : classLinkStatus?.configured
                ? '关闭（已配置）'
                : '未配置',
        ],
        [
          '网易云账号',
          account.loggedIn
            ? account.profile?.nickname || String(account.profile?.userId)
            : '未登录',
        ],
      ]
    : []
  const classLinkRows: Array<[string, string]> =
    settingsConfig && classLinkStatus
      ? [
          [
            '联动状态',
            classLinkStatus.enabled
              ? classLinkStatus.connected
                ? '开启 · 已连接'
                : '开启 · 等待连接'
              : '关闭',
          ],
          ['监听端口', String(settingsConfig.classLink.port)],
          ['连接令牌', classLinkStatus.configured ? '已配置' : '未配置'],
          ['删除配置', classLinkStatus.configured ? '断开并删除令牌' : '无令牌可删除'],
        ]
      : []

  const interactionPanel = (
    <Box
      marginTop={1}
      borderStyle="round"
      borderColor={mode === 'normal' ? 'gray' : 'cyan'}
      paddingX={1}
      flexDirection="column"
    >
      {mode === 'normal' ? (
        <>
          <Text>
            <Text color="cyan">/</Text> 搜索 · <Text color="cyan">L</Text> 音乐库 ·{' '}
            <Text color="cyan">TAB</Text> 队列 · <Text color="cyan">R</Text> 评论 ·{' '}
            <Text color="cyan">S</Text> 加歌单 · <Text color="cyan">O</Text> 设置
          </Text>
          <Text dimColor>
            SPACE 播放/暂停 · ← → 进度 · ↑ ↓ 音量 · P / N 切歌 · F 喜欢 · M 模式
            {status.queueContext?.type === 'fm' ? ' · d FM 垃圾桶' : ''}
          </Text>
        </>
      ) : null}
      {mode === 'search' ? (
        <Text>
          搜索{searchTypeLabels[searchType]} ›{' '}
          <Text color="cyan">{shownInput || '输入关键词'}█</Text>
          <Text dimColor> Tab 切换类型</Text>
        </Text>
      ) : null}
      {mode === 'cookie' ? (
        <Text>
          Cookie ›{' '}
          <Text color="yellow">
            {'•'.repeat(Math.min(inputValue.length, Math.max(8, terminalWidth - 18)))}█
          </Text>
          <Text dimColor> 回车验证并保存，Esc 取消</Text>
        </Text>
      ) : null}
      {mode === 'classlink-token' ? (
        <Text>
          ClassLink 令牌 ›{' '}
          <Text color="yellow">
            {'•'.repeat(Math.min(inputValue.length, Math.max(8, terminalWidth - 26)))}█
          </Text>
          <Text dimColor> 回车保存并启用，Esc 取消</Text>
        </Text>
      ) : null}
      {mode === 'classlink-port' ? (
        <Text>
          ClassLink 端口 › <Text color="cyan">{shownInput || '38973'}█</Text>
          <Text dimColor> 范围 1024-65535，Enter 保存，Esc 取消</Text>
        </Text>
      ) : null}
      {mode === 'results' ? (
        <>
          <Text bold>搜索结果（Enter 播放，n 下一首，e 入队列，s 加歌单，/ 搜索）</Text>
          {visibleResults.map((song, offset) => {
            const index = resultStart + offset
            return (
              <Text key={song.id} color={index === selectedIndex ? 'cyan' : undefined}>
                {index === selectedIndex ? '▶ ' : '  '}
                {songLabel(song)} [{song.id}]
              </Text>
            )
          })}
        </>
      ) : null}
      {mode === 'search-playlists' ? (
        <>
          <Text bold>歌单搜索结果（↑/↓ 选择，Enter 查看，f 收藏/取消，/ 搜索）</Text>
          {visibleSearchPlaylists.map((playlist, offset) => {
            const index = searchPlaylistStart + offset
            return (
              <Text key={playlist.id} color={index === selectedIndex ? 'cyan' : undefined}>
                {index === selectedIndex ? '▶ ' : '  '}
                {playlist.subscribed ? '♥ ' : ''}
                {playlist.name} · {playlist.trackCount} 首 [{playlist.id}]
              </Text>
            )
          })}
        </>
      ) : null}
      {mode === 'search-collections' ? (
        <>
          <Text bold>
            {searchCollectionType === 'album' ? '专辑' : '歌手'}搜索结果（↑/↓ 选择，Enter 查看，/
            搜索）
          </Text>
          {visibleSearchCollections.map((collection, offset) => {
            const index = searchCollectionStart + offset
            return (
              <Text
                key={`${collection.type}-${collection.id}`}
                color={index === selectedIndex ? 'cyan' : undefined}
              >
                {index === selectedIndex ? '▶ ' : '  '}
                {collection.name}
                {collection.subtitle ? ` — ${collection.subtitle}` : ''}
                {collection.count ? ` · ${collection.count} 首` : ''}
              </Text>
            )
          })}
        </>
      ) : null}
      {mode === 'queue' ? (
        <>
          <Text bold>播放队列（↑/↓ 选择，Enter 播放，x 删除，[ / ] 移动，Shift+C 清空）</Text>
          {visibleQueue.length ? (
            visibleQueue.map((song, offset) => {
              const index = queueStart + offset
              return (
                <Text key={`${song.id}-${index}`} color={index === queueIndex ? 'cyan' : undefined}>
                  {index === queueIndex ? '▶ ' : '  '}
                  {songLabel(song)}
                </Text>
              )
            })
          ) : (
            <Text dimColor>队列为空，请先搜索并播放歌曲</Text>
          )}
        </>
      ) : null}
      {mode === 'library' ? (
        <>
          <Text bold>音乐库（↑/↓ 选择，Enter 打开，l/Esc 返回）</Text>
          {[
            '我的歌单',
            '每日推荐歌曲',
            '每日推荐歌单',
            '歌单广场',
            '网易云官方榜单',
            '新歌速递',
            '私人 FM',
            '心动模式',
            '最近播放',
            '音乐云盘',
            '收藏专辑',
            '关注歌手',
            '本周听歌排行',
            '全部听歌排行',
          ].map((label, index) => (
            <Text key={label} color={index === libraryIndex ? 'cyan' : undefined}>
              {index === libraryIndex ? '▶ ' : '  '}
              {label}
            </Text>
          ))}
        </>
      ) : null}
      {mode === 'discover-categories' ? (
        <>
          <Text bold>歌单广场（↑/↓ 选择分类，Enter 打开，Esc 返回）</Text>
          {discoverEntries.map((entry, index) => (
            <Text
              key={`${entry.kind}-${entry.name}`}
              color={index === libraryIndex ? 'cyan' : undefined}
            >
              {index === libraryIndex ? '▶ ' : '  '}
              {entry.name}
            </Text>
          ))}
        </>
      ) : null}
      {mode === 'new-regions' ? (
        <>
          <Text bold>新歌速递（↑/↓ 选择地区，Enter 打开，Esc 返回）</Text>
          {newSongRegions.map((region, index) => (
            <Text key={region.area} color={index === libraryIndex ? 'cyan' : undefined}>
              {index === libraryIndex ? '▶ ' : '  '}
              {region.name}
            </Text>
          ))}
        </>
      ) : null}
      {mode === 'playlists' ? (
        <>
          <Text bold>
            {playlistPageTitle}
            {playlistPageKind === 'library'
              ? '（Enter 查看，c 创建，Shift+R 重命名，Shift+D 删除，f 收藏）'
              : playlistPageKind === 'daily'
                ? '（Enter 查看，f 收藏，Esc 返回）'
                : playlistPageKind === 'discover'
                  ? '（Enter 查看，f 收藏，Esc 返回）'
                  : '（Enter 查看，Esc 返回）'}
          </Text>
          {visiblePlaylists.map((playlist, offset) => {
            const index = playlistStart + offset
            return (
              <Text key={playlist.id} color={index === libraryIndex ? 'cyan' : undefined}>
                {index === libraryIndex ? '▶ ' : '  '}
                {playlist.subscribed ? '♥ ' : ''}
                {playlist.name} · {playlist.trackCount} 首
                {playlist.updateFrequency ? ` · ${playlist.updateFrequency}` : ''}
              </Text>
            )
          })}
        </>
      ) : null}
      {mode === 'playlist-edit' ? (
        <Text>
          {playlistEditAction === 'create' ? '创建歌单' : '重命名歌单'} ›{' '}
          <Text color="cyan">{shownInput || '输入歌单名称'}█</Text>
          <Text dimColor> Enter 保存 · Esc 取消</Text>
        </Text>
      ) : null}
      {mode === 'playlist-picker' ? (
        <>
          <Text bold>
            加入歌单 · {playlistPickerSong?.name || '歌曲'}（↑/↓ 选择，Enter 确认，Esc 返回）
          </Text>
          {visiblePlaylists.map((playlist, offset) => {
            const index = playlistStart + offset
            return (
              <Text key={playlist.id} color={index === libraryIndex ? 'cyan' : undefined}>
                {index === libraryIndex ? '▶ ' : '  '}
                {playlist.name} · {playlist.trackCount} 首
              </Text>
            )
          })}
        </>
      ) : null}
      {mode === 'collections' ? (
        <>
          <Text bold>
            {collectionType === 'album' ? '收藏专辑' : '关注歌手'}（↑/↓ 选择，Enter 查看，Esc 返回）
          </Text>
          {visibleCollections.map((collection, offset) => {
            const index = collectionStart + offset
            return (
              <Text
                key={`${collection.type}-${collection.id}`}
                color={index === libraryIndex ? 'cyan' : undefined}
              >
                {index === libraryIndex ? '▶ ' : '  '}
                {collection.name}
                {collection.subtitle ? ` — ${collection.subtitle}` : ''}
                {collection.count ? ` · ${collection.count} 首` : ''}
              </Text>
            )
          })}
        </>
      ) : null}
      {mode === 'tracks' ? (
        <>
          <Text bold>
            {librarySource?.name || '歌曲列表'}（Enter 播放，a 全部，n 下一首，e 入队列，s 加歌单
            {librarySource?.type === 'playlist'
              ? `，r 评论${librarySource.owned ? '，x 移除' : ''}`
              : ''}
            ，Esc 返回）
          </Text>
          {visibleTracks.map((song, offset) => {
            const index = trackStart + offset
            return (
              <Text key={`${song.id}-${index}`} color={index === libraryIndex ? 'cyan' : undefined}>
                {index === libraryIndex ? '▶ ' : '  '}
                {songLabel(song)}
              </Text>
            )
          })}
        </>
      ) : null}
      {mode === 'comments' ? (
        <>
          <Text bold>
            {commentTitle}（{commentTotal} 条，↑/↓ 浏览，Esc 返回）
          </Text>
          {visibleComments.length ? (
            visibleComments.map((comment, offset) => {
              const index = commentStart + offset
              return (
                <Box key={comment.id} flexDirection="column" marginBottom={1}>
                  <Text color={index === commentIndex ? 'cyan' : undefined}>
                    {index === commentIndex ? '▶ ' : '  '}
                    {comment.user.nickname} · ♡ {comment.likedCount} ·{' '}
                    {new Date(comment.time).toLocaleDateString('zh-CN')}
                  </Text>
                  <Text>
                    {comment.content.replace(/\s+/g, ' ').slice(0, Math.max(12, terminalWidth - 6))}
                  </Text>
                </Box>
              )
            })
          ) : (
            <Text dimColor>暂无评论</Text>
          )}
        </>
      ) : null}
      {mode === 'settings' ? (
        <>
          <Text bold>设置（↑/↓ 选择，←/→/Enter 修改，o/,/Esc 返回）</Text>
          {settingsRows.map(([label, value], index) => (
            <Text key={label} color={index === settingsIndex ? 'cyan' : undefined}>
              {index === settingsIndex ? '▶ ' : '  '}
              {label.padEnd(12, ' ')} {value}
            </Text>
          ))}
          <Text dimColor>听歌上报按真实播放时长自动触发，每个播放周期只提交一次。</Text>
          <Text dimColor>
            最近上报：
            {status.lastScrobble
              ? `${status.lastScrobble.ok ? '成功' : '失败'} · ${status.lastScrobble.mode} · ${status.lastScrobble.playedSeconds}s`
              : '本次 daemon 启动后暂无记录'}
          </Text>
        </>
      ) : null}
      {mode === 'classlink' ? (
        <>
          <Text bold>ClassLink 设置（↑/↓ 选择，Enter 修改，Esc 返回设置）</Text>
          {classLinkRows.map(([label, value], index) => (
            <Text key={label} color={index === classLinkIndex ? 'cyan' : undefined}>
              {index === classLinkIndex ? '▶ ' : '  '}
              {label.padEnd(12, ' ')} {value}
            </Text>
          ))}
          <Text dimColor>
            地址：{classLinkStatus?.endpoint || 'http://127.0.0.1:38973'} ·{' '}
            {classLinkStatus?.connected
              ? 'ClassIsland 已连接'
              : classLinkStatus?.lastError || '尚未建立连接'}
          </Text>
          <Text dimColor>连接令牌只保存在敏感配置文件中，设置页不会显示原文。</Text>
        </>
      ) : null}
      {mode === 'account' ? (
        <>
          <Text bold>账号设置（↑/↓ 选择，Enter 执行，Esc 返回设置）</Text>
          {['Cookie 登录', '二维码登录', '验证账号', '退出账号'].map((label, index) => (
            <Text key={label} color={index === accountIndex ? 'cyan' : undefined}>
              {index === accountIndex ? '▶ ' : '  '}
              {label}
            </Text>
          ))}
          <Text dimColor>
            当前账号：
            {account.loggedIn
              ? `${account.profile?.nickname || account.profile?.userId}（已登录）`
              : '未登录'}
          </Text>
          {accountProfile ? (
            <>
              <Text dimColor>
                Lv.{accountProfile.level} · 累计听歌 {accountProfile.listenSongs} · 关注{' '}
                {accountProfile.follows} · 粉丝 {accountProfile.followeds}
              </Text>
              <Text dimColor>
                歌单 {accountProfile.playlistCount} · 动态 {accountProfile.eventCount}
                {accountProfile.vipType > 0 ? ' · 黑胶会员' : ''}
              </Text>
              {accountProfile.signature ? (
                <Text dimColor>签名：{accountProfile.signature}</Text>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {mode === 'qr' ? (
        <>
          <Text>{qrText}</Text>
          <Text dimColor>扫码后会自动完成登录，Esc 取消</Text>
        </>
      ) : null}
    </Box>
  )

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1} height={playerLayout.height}>
      <Box justifyContent="space-between">
        <Text bold color={process.env.NO_COLOR ? undefined : 'red'}>
          ◆ CLOUDMUSIC <Text dimColor>TERMINAL PLAYER</Text>
        </Text>
        <Text color={account.loggedIn ? 'green' : 'yellow'}>
          {account.loggedIn
            ? `● ${account.profile?.nickname || account.profile?.userId}`
            : '○ 未登录'}
        </Text>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={2} flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="white">
            <Text color="red">{stateIcon}</Text> {status.song?.name || '选择一首歌开始播放'}
          </Text>
          <Text color={status.liked ? 'red' : 'gray'}>
            {status.liked && process.env.NO_COLOR ? '♥' : '♡'}
          </Text>
        </Box>
        <Text dimColor>
          {artists} · {status.song?.album.name || '暂无专辑信息'}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>{formatTime(visualPosition)} </Text>
          <Text color={process.env.NO_COLOR ? undefined : '#ef4444'}>
            {(process.env.NO_COLOR ? '━' : '─').repeat(progressBar.completedCells)}
          </Text>
          {progressBar.hasTransition ? (
            <Text
              color={
                process.env.NO_COLOR
                  ? undefined
                  : mixHexColors('#475569', '#ef4444', progressBar.transitionIntensity)
              }
            >
              {process.env.NO_COLOR ? '╾' : '─'}
            </Text>
          ) : null}
          <Text color={process.env.NO_COLOR ? undefined : '#475569'}>
            {'─'.repeat(progressBar.remainingCells)}
          </Text>
          <Text dimColor> {formatTime(status.duration)}</Text>
        </Box>
        <Text dimColor>
          {modeLabel[status.mode]} · 音量 {status.volume}% · {status.quality || '未知音质'}
          {sourceLabel ? ` · ${sourceLabel}` : ''}
        </Text>
        <Text dimColor>
          {status.queueContext?.name || '临时队列'} · {Math.max(0, status.queueIndex + 1)} /{' '}
          {status.queueLength}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={playerLayout.expanded ? 1 : 0}>
        <Box
          marginTop={playerLayout.expanded ? 0 : 1}
          paddingX={2}
          flexDirection="column"
          flexGrow={playerLayout.expanded ? 1 : 0}
          justifyContent={playerLayout.expanded ? 'space-around' : 'flex-start'}
        >
          <Text dimColor>LYRICS · {(status.lyricFormat || 'lrc').toUpperCase()}</Text>
          {visiblePreviousLyricLines?.map((line, index) => (
            <ContextLyricLine
              key={`previous-${line.time}-${line.text}`}
              line={line}
              emphasis={
                index === visiblePreviousLyricLines.length - 1 ? 1 - currentLineEntrance : 0
              }
            />
          ))}
          <Box flexDirection="column" marginY={playerLayout.expanded ? 0 : 1}>
            <TimedLyricLine
              line={status.currentLyricLine}
              position={lyricVisualPosition}
              emphasis={currentLineEmphasis}
              waiting={!status.currentLyricLine && Boolean(status.nextLyricLine)}
              waitingUntil={status.nextLyricLine?.time || 0}
              placeholderAlignRight={Boolean(status.nextLyricLine?.isDuet)}
            />
            {status.currentLyricLine?.translation ? (
              <Box
                width="100%"
                justifyContent={status.currentLyricLine.isDuet ? 'flex-end' : 'flex-start'}
              >
                <Text color={mixHexColors('#64748b', '#facc15', currentLineEmphasis)}>
                  {status.currentLyricLine.translation}
                </Text>
              </Box>
            ) : null}
            {status.backgroundLyricLines?.slice(0, 1).map((line) => (
              <TimedLyricLine
                key={`${line.time}-${line.text}`}
                line={line}
                position={lyricVisualPosition}
                emphasis={getLyricLineTransition(lyricVisualPosition, line.time)}
              />
            ))}
          </Box>
          {visibleUpcomingLyricLines?.map((line, index) => (
            <ContextLyricLine
              key={`upcoming-${line.time}-${line.text}`}
              line={line}
              emphasis={index === 0 ? nextLineEntrance : 0}
              emphasisColor={line.words?.length ? '#94a3b8' : '#22d3ee'}
            />
          ))}
        </Box>
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {interactionPanel}
        <Box justifyContent="space-between" paddingX={1}>
          <Text color={status.error ? 'red' : 'yellow'}>
            {status.error ? `! ${status.error}` : `› ${message}`}
          </Text>
          <Text dimColor>Q 退出界面 · X 彻底退出并关闭播放</Text>
        </Box>
        <Box marginTop={1} paddingX={1} flexDirection="column">
          <Box justifyContent="space-between">
            <Text dimColor>SPECTRUM</Text>
            <Text dimColor>48 kHz · PCM</Text>
          </Box>
          <Spectrum frame={spectrum} width={playerLayout.spectrumWidth} />
        </Box>
      </Box>
    </Box>
  )
}
