import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import qrcode from 'qrcode-terminal'
import { ensureDaemon, requestDaemon } from '../ipc/client.js'
import type { PlaybackStatus, QueueSnapshot, Song, SpectrumFrame } from '../core/types.js'

type PageMode = 'normal' | 'search' | 'results' | 'cookie' | 'qr' | 'queue'

const callDaemon = async <T = unknown,>(method: string, params?: Record<string, unknown>) => {
  try {
    return await requestDaemon<T>(method, params)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (!['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(code || '')) throw error
    await ensureDaemon()
    return requestDaemon<T>(method, params)
  }
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

  const playSong = async (song: Song) => {
    setMessage(`正在加载：${songLabel(song)}`)
    try {
      await callDaemon('play', { id: song.id })
      await refreshQueue()
      setMode('normal')
      setInputValue('')
      setMessage(`正在播放：${songLabel(song)}`)
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
      if (key.return && searchResults[selectedIndex]) void playSong(searchResults[selectedIndex])
      return
    }

    if (mode === 'queue') {
      if (key.escape || key.tab) return setMode('normal')
      if (key.upArrow) return setQueueIndex((index) => Math.max(0, index - 1))
      if (key.downArrow)
        return setQueueIndex((index) => Math.min(queue.songs.length - 1, index + 1))
      if (key.return && queue.songs[queueIndex]) void playSong(queue.songs[queueIndex])
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
  const shownInput = inputValue.slice(-Math.max(12, terminalWidth - 18))

  const interactionPanel = (
    <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
      {mode === 'normal' ? (
        <>
          <Text>一页操作：/ 搜索 · c Cookie 登录 · g 二维码登录 · v 验证账号 · u 退出账号</Text>
          <Text dimColor>Tab 打开队列 · Space 暂停/恢复 · 方向键进度/音量 · p/n 切歌</Text>
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
          {status.queueLength}
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
