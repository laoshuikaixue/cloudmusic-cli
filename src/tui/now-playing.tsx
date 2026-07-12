import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import qrcode from 'qrcode-terminal'
import { requestDaemonResilient } from '../ipc/client.js'
import type {
  AppConfig,
  PlaybackMode,
  PlaybackStatus,
  PlaylistSummary,
  QueueSnapshot,
  Song,
  SpectrumFrame,
} from '../core/types.js'

type PageMode =
  | 'normal'
  | 'search'
  | 'results'
  | 'cookie'
  | 'qr'
  | 'queue'
  | 'library'
  | 'playlists'
  | 'tracks'
  | 'settings'

type LibrarySource =
  { type: 'playlist'; id: number; name: string } | { type: 'daily'; name: string }

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
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '00:00'
  const minute = Math.floor(seconds / 60)
  const second = Math.floor(seconds % 60)
  return `${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

const songLabel = (song: Song) => {
  const artists = song.artists.map((artist) => artist.name).join(' / ')
  return `${song.name} — ${artists}`
}

const Spectrum = ({ frame, width }: { frame: SpectrumFrame; width: number }) => {
  const characters = ' ▁▂▃▄▅▆▇█'
  const usableWidth = Math.max(12, Math.min(96, width - 4))
  const bars = useMemo(() => {
    const values: number[] = []
    for (let index = 0; index < usableWidth; index += 1) {
      const sourceIndex = Math.floor((index / usableWidth) * frame.bins.length)
      values.push(frame.bins[sourceIndex] || 0)
    }
    return values
      .map((value) => characters[Math.min(characters.length - 1, Math.round(value * 8))])
      .join('')
  }, [frame, usableWidth])
  return <Text color={process.env.NO_COLOR ? undefined : 'cyan'}>{bars}</Text>
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
  const [queue, setQueue] = useState<QueueSnapshot>({ songs: [], index: -1 })
  const [mode, setMode] = useState<PageMode>('normal')
  const [inputValue, setInputValue] = useState('')
  const [searchResults, setSearchResults] = useState<Song[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [queueIndex, setQueueIndex] = useState(0)
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const [librarySongs, setLibrarySongs] = useState<Song[]>([])
  const [libraryIndex, setLibraryIndex] = useState(0)
  const [librarySource, setLibrarySource] = useState<LibrarySource | null>(null)
  const [settingsConfig, setSettingsConfig] = useState<AppConfig | null>(null)
  const [settingsIndex, setSettingsIndex] = useState(0)
  const [qrText, setQrText] = useState('')
  const [message, setMessage] = useState('按 / 搜索歌曲，按 c 使用 Cookie 登录')
  const [terminalWidth, setTerminalWidth] = useState(process.stdout.columns || 80)
  const qrTimer = useRef<NodeJS.Timeout | undefined>(undefined)

  const runControl = (method: string, params?: Record<string, unknown>) => {
    void callDaemon(method, params).catch((error) =>
      setMessage(error instanceof Error ? error.message : String(error)),
    )
  }

  const refreshQueue = async () => {
    try {
      const result = await callDaemon<QueueSnapshot>('queue.list')
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
    const resize = () => setTerminalWidth(process.stdout.columns || 80)
    process.stdout.on('resize', resize)
    void verifyAccount()
    void refreshQueue()
    const queueTimer = setInterval(() => void refreshQueue(), 2000)
    let polling = false
    const playerTimer = setInterval(() => {
      if (polling) return
      polling = true
      void Promise.all([
        callDaemon<PlaybackStatus>('status'),
        callDaemon<SpectrumFrame>('spectrum'),
      ])
        .then(([nextStatus, nextSpectrum]) => {
          setStatus(nextStatus)
          setSpectrum(nextSpectrum)
        })
        .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
        .finally(() => {
          polling = false
        })
    }, 120)
    return () => {
      process.stdout.off('resize', resize)
      clearInterval(queueTimer)
      clearInterval(playerTimer)
      if (qrTimer.current) clearInterval(qrTimer.current)
    }
  }, [])

  const submitSearch = async () => {
    const keywords = inputValue.trim()
    if (!keywords) return
    setMessage(`正在搜索：${keywords}`)
    try {
      const result = await callDaemon<{ songs: Song[] }>('search', { keywords, limit: 20 })
      setSearchResults(result.songs)
      setSelectedIndex(0)
      setMode('results')
      setMessage(result.songs.length ? `找到 ${result.songs.length} 首歌曲` : '没有搜索结果')
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

  const openPlaylists = async () => {
    setMessage('正在加载账号歌单…')
    try {
      const result = await callDaemon<PlaylistSummary[]>('library.playlists')
      setPlaylists(result)
      setLibraryIndex(0)
      setMode('playlists')
      setMessage(`已加载 ${result.length} 个歌单`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openPlaylist = async (playlist: PlaylistSummary) => {
    setMessage(`正在加载歌单：${playlist.name}…`)
    try {
      const result = await callDaemon<{ playlist: PlaylistSummary; songs: Song[] }>(
        'library.playlist',
        { id: playlist.id },
      )
      setLibrarySongs(result.songs)
      setLibrarySource({ type: 'playlist', id: playlist.id, name: playlist.name })
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
      setLibraryIndex(0)
      setMode('tracks')
      setMessage(`每日推荐 · ${songs.length} 首歌曲`)
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
      } else {
        await callDaemon('library.daily.play', { index })
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

  const openSettings = async () => {
    setMessage('正在加载设置…')
    try {
      setSettingsConfig(await callDaemon<AppConfig>('config.get'))
      setSettingsIndex(0)
      setMode('settings')
      setMessage('设置会立即保存并应用')
    } catch (error) {
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
        await callDaemon('config.set', { patch })
      }
      setSettingsConfig(await callDaemon<AppConfig>('config.get'))
      setMessage('设置已保存')
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
      setMode('normal')
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
            setMode('normal')
            setQrText('')
            setMessage(`登录成功：${check.profile?.nickname || '网易云用户'}`)
          } else if (check.code === 800) {
            if (qrTimer.current) clearInterval(qrTimer.current)
            setMode('normal')
            setQrText('')
            setMessage('二维码已过期，请按 g 重新生成')
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
    if (mode === 'search' || mode === 'cookie') {
      if (key.escape) {
        setInputValue('')
        setMode('normal')
        return
      }
      if (key.return) {
        void (mode === 'search' ? submitSearch() : submitCookie())
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
      return
    }

    if (mode === 'library') {
      if (key.escape || input === 'l') return setMode('normal')
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) return setLibraryIndex((index) => Math.min(2, index + 1))
      if (key.return) {
        if (libraryIndex === 0) void openPlaylists()
        if (libraryIndex === 1) void openDaily()
        if (libraryIndex === 2) void playFm()
      }
      return
    }

    if (mode === 'playlists') {
      if (key.escape) return setMode('library')
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow)
        return setLibraryIndex((index) => Math.min(playlists.length - 1, index + 1))
      if (key.return && playlists[libraryIndex]) void openPlaylist(playlists[libraryIndex])
      return
    }

    if (mode === 'tracks') {
      if (key.escape) return setMode(librarySource?.type === 'playlist' ? 'playlists' : 'library')
      if (key.upArrow) return setLibraryIndex((index) => Math.max(0, index - 1))
      if (key.downArrow)
        return setLibraryIndex((index) => Math.min(librarySongs.length - 1, index + 1))
      if (key.return && librarySongs[libraryIndex]) void playLibrary(libraryIndex)
      if (input === 'a' && librarySongs.length) void playLibrary(0)
      return
    }

    if (mode === 'settings') {
      if (key.escape || input === 'o' || input === ',') return setMode('normal')
      if (key.upArrow) return setSettingsIndex((index) => Math.max(0, index - 1))
      if (key.downArrow) return setSettingsIndex((index) => Math.min(5, index + 1))
      if (key.leftArrow) void changeSetting(settingsIndex, -1)
      if (key.rightArrow || key.return || input === ' ') void changeSetting(settingsIndex, 1)
      return
    }

    if (mode === 'qr') {
      if (key.escape) {
        if (qrTimer.current) clearInterval(qrTimer.current)
        setQrText('')
        setMode('normal')
      }
      return
    }

    if (input === 'q' || key.escape) return exit()
    if (input === '/') {
      setInputValue('')
      return setMode('search')
    }
    if (input === 'c') {
      setInputValue('')
      return setMode('cookie')
    }
    if (input === 'g') return void beginQrLogin()
    if (input === 'l') {
      setLibraryIndex(0)
      return setMode('library')
    }
    if (input === 'o' || input === ',') return void openSettings()
    if (input === 'v') return void verifyAccount()
    if (input === 'u') {
      void callDaemon('logout')
        .then(() => {
          setAccount({ loggedIn: false, valid: false })
          setMessage('已退出网易云账号')
        })
        .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      return
    }
    if (key.tab) return setMode('queue')
    if (input === 'f' && status.song) {
      runControl('like', { id: status.song.id, liked: !status.liked })
      setMessage(status.liked ? '已取消喜欢' : '已加入喜欢')
    }
    if (input === 'm') {
      const modes: PlaybackMode[] = ['sequence', 'repeat-one', 'shuffle']
      const nextMode = modes[(modes.indexOf(status.mode) + 1) % modes.length]
      runControl('mode.set', { mode: nextMode })
      setMessage(`播放模式：${nextMode}`)
    }
    if (input === 'd' && status.queueContext?.type === 'fm') {
      runControl('library.fm.trash')
      setMessage('已移入 FM 垃圾桶并播放下一首')
    }
    if (input === ' ') runControl('toggle')
    if (input === 'n') runControl('next')
    if (input === 'p') runControl('previous')
    if (key.leftArrow) runControl('seek', { value: -5, relative: true })
    if (key.rightArrow) runControl('seek', { value: 5, relative: true })
    if (key.upArrow) runControl('volume', { value: Math.min(100, status.volume + 5) })
    if (key.downArrow) runControl('volume', { value: Math.max(0, status.volume - 5) })
  })

  const artists = status.song?.artists.map((artist) => artist.name).join(' / ') || '—'
  const progressWidth = Math.max(10, Math.min(60, terminalWidth - 28))
  const progress = status.duration ? Math.max(0, Math.min(1, status.position / status.duration)) : 0
  const filled = Math.round(progress * progressWidth)
  const progressBar = `${'━'.repeat(filled)}${'─'.repeat(progressWidth - filled)}`
  const resultStart = Math.max(0, Math.min(selectedIndex - 3, searchResults.length - 8))
  const visibleResults = searchResults.slice(resultStart, resultStart + 8)
  const queueStart = Math.max(0, Math.min(queueIndex - 3, queue.songs.length - 8))
  const visibleQueue = queue.songs.slice(queueStart, queueStart + 8)
  const playlistStart = Math.max(0, Math.min(libraryIndex - 3, playlists.length - 8))
  const visiblePlaylists = playlists.slice(playlistStart, playlistStart + 8)
  const trackStart = Math.max(0, Math.min(libraryIndex - 3, librarySongs.length - 8))
  const visibleTracks = librarySongs.slice(trackStart, trackStart + 8)
  const shownInput = inputValue.slice(-Math.max(12, terminalWidth - 18))
  const settingsRows: Array<[string, string]> = settingsConfig
    ? [
        ['听歌上报', settingsConfig.scrobble.enabled ? '开启' : '关闭'],
        ['上报方式', settingsConfig.scrobble.mode === 'ncbl' ? 'NCBL (PLV/PLD)' : 'Legacy'],
        ['默认音质', settingsConfig.quality],
        ['解灰回退', settingsConfig.unblock.enabled ? '开启' : '关闭'],
        ['官方试听', settingsConfig.allowTrial ? '允许' : '关闭'],
        ['Windows SMTC', settingsConfig.smtc.enabled ? '开启' : '关闭'],
      ]
    : []

  const interactionPanel = (
    <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
      {mode === 'normal' ? (
        <>
          <Text>一页操作：/ 搜索 · l 音乐库 · Tab 队列 · c/g 登录 · v 验证 · u 退出账号</Text>
          <Text dimColor>
            Space 暂停 · 方向键进度/音量 · p/n 切歌 · f 喜欢 · m 模式 · o/, 设置
            {status.queueContext?.type === 'fm' ? ' · d FM 垃圾桶' : ''}
          </Text>
        </>
      ) : null}
      {mode === 'search' ? (
        <Text>
          搜索歌曲 › <Text color="cyan">{shownInput || '输入关键词'}█</Text>
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
      {mode === 'results' ? (
        <>
          <Text bold>搜索结果（↑/↓ 选择，Enter 播放，/ 重新搜索）</Text>
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
      {mode === 'queue' ? (
        <>
          <Text bold>播放队列（↑/↓ 选择，Enter 播放，Tab/Esc 返回）</Text>
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
          {['我的歌单', '每日推荐', '私人 FM'].map((label, index) => (
            <Text key={label} color={index === libraryIndex ? 'cyan' : undefined}>
              {index === libraryIndex ? '▶ ' : '  '}
              {label}
            </Text>
          ))}
        </>
      ) : null}
      {mode === 'playlists' ? (
        <>
          <Text bold>我的歌单（↑/↓ 选择，Enter 查看，Esc 返回）</Text>
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
      {mode === 'tracks' ? (
        <>
          <Text bold>
            {librarySource?.name || '歌曲列表'}（↑/↓ 选择，Enter 从此播放，a 播放全部，Esc 返回）
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
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={process.env.NO_COLOR ? undefined : 'green'}>
          CloudMusic CLI
        </Text>
        <Text color={account.loggedIn ? 'green' : 'yellow'}>
          {account.loggedIn
            ? `网易云：${account.profile?.nickname || account.profile?.userId}`
            : '网易云：未登录'}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>
          {status.state === 'playing' ? '▶' : status.state === 'paused' ? '⏸' : '■'}{' '}
          {status.song?.name || '尚未播放歌曲'}
        </Text>
        <Text dimColor>
          {artists} · {status.song?.album.name || '—'}
        </Text>
        <Text>
          {formatTime(status.position)} {progressBar} {formatTime(status.duration)}
        </Text>
        <Text dimColor>
          音量 {status.volume}% · 音质 {status.quality || '—'} · 来源 {status.source || '—'}
          {status.sourceName ? `:${status.sourceName}` : ''} · 队列 {status.queueIndex + 1}/
          {status.queueLength} · 模式 {status.mode} · {status.liked ? '♥ 已喜欢' : '♡ 未喜欢'}
        </Text>
        <Text dimColor>
          列表：{status.queueContext?.name || status.queueContext?.type || '临时队列'} · 听歌上报{' '}
          {status.scrobbleEnabled ? `开启(${status.scrobbleMode})` : '关闭'}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>{status.currentLyric || '暂无同步歌词'}</Text>
        <Text dimColor>{status.nextLyric || ' '}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Spectrum frame={spectrum} width={terminalWidth} />
      </Box>

      {interactionPanel}
      <Text color={status.error ? 'red' : 'yellow'}>{status.error || message}</Text>
      <Text dimColor>q 退出页面但保留后台播放</Text>
    </Box>
  )
}
