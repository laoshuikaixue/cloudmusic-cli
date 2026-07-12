#!/usr/bin/env node
import React from 'react'
import { Command } from 'commander'
import { render } from 'ink'
import qrcode from 'qrcode-terminal'
import { runDaemonServer } from './ipc/server.js'
import { ensureDaemon, requestDaemon, subscribeDaemon } from './ipc/client.js'
import { runMcpServer } from './mcp/server.js'
import { NowPlaying } from './tui/now-playing.js'
import { toAppError } from './core/errors.js'
import type { OutputEnvelope, PlaybackStatus, Song, SpectrumFrame } from './core/types.js'

const VERSION = '0.1.0'

if (process.argv[2] === '__daemon') {
  await runDaemonServer()
  await new Promise(() => undefined)
}

const program = new Command()
  .name('ncm')
  .description('CloudMusic CLI - 终端网易云音乐播放器')
  .version(VERSION)
  .option('--json', '以稳定 JSON 格式输出')

const envelope = <T>(data: T): OutputEnvelope<T> => ({
  ok: true,
  data,
  meta: { version: VERSION, timestamp: new Date().toISOString() },
})

const output = (data: unknown, human?: () => void) => {
  if (program.opts().json) console.log(JSON.stringify(envelope(data)))
  else if (human) human()
  else console.log(JSON.stringify(data, null, 2))
}

const withDaemon = async <T>(method: string, params?: Record<string, unknown>) => {
  await ensureDaemon()
  return requestDaemon<T>(method, params)
}

const formatSong = (song: Song, index?: number) => {
  const prefix = index === undefined ? '' : `${String(index + 1).padStart(2, ' ')}. `
  const artists = song.artists.map((artist) => artist.name).join(' / ')
  return `${prefix}${song.name} — ${artists} [${song.id}]`
}

const readCookieInput = async () => {
  if (!process.stdin.isTTY) {
    let value = ''
    for await (const chunk of process.stdin) value += chunk.toString()
    return value.trim()
  }
  if (program.opts().json) {
    throw new Error('JSON 模式下请通过参数或 stdin 提供 Cookie')
  }
  if (!process.stdin.setRawMode) {
    throw new Error('当前终端不支持隐藏输入，请通过 stdin 提供 Cookie')
  }

  process.stderr.write('请粘贴网易云 Cookie（输入内容已隐藏，回车确认）：')
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stderr.write('\n')
    }
    const onData = (buffer: Buffer) => {
      for (const character of buffer.toString('utf8')) {
        if (character === '\u0003') {
          finish()
          reject(new Error('已取消 Cookie 输入'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          resolve(value.trim())
          return
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length) {
            value = value.slice(0, -1)
            process.stderr.write('\b \b')
          }
          continue
        }
        value += character
        process.stderr.write('•')
      }
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

program
  .command('search <keywords>')
  .description('搜索歌曲')
  .option('-l, --limit <number>', '返回数量', '20')
  .action(async (keywords, options) => {
    const result = await withDaemon<{ songs: Song[]; total: number }>('search', {
      keywords,
      limit: Number(options.limit),
    })
    output(result, () =>
      result.songs.forEach((song, index) => console.log(formatSong(song, index))),
    )
  })

program
  .command('play <id>')
  .description('播放歌曲 ID')
  .action(async (id) => output(await withDaemon('play', { id: Number(id) })))

for (const [name, method] of [
  ['pause', 'pause'],
  ['resume', 'resume'],
  ['toggle', 'toggle'],
  ['stop', 'stop'],
  ['next', 'next'],
  ['prev', 'previous'],
] as const) {
  program
    .command(name)
    .description(`${name} 播放控制`)
    .action(async () => output(await withDaemon(method)))
}

program
  .command('status')
  .description('查看播放器状态')
  .option('-w, --watch', '持续输出状态')
  .option('--jsonl', '持续输出 NDJSON')
  .action(async (options) => {
    if (!options.watch) return output(await withDaemon('status'))
    await ensureDaemon()
    await subscribeDaemon((event) => {
      if (event.event !== 'status') return
      if (options.jsonl || program.opts().json) console.log(JSON.stringify(envelope(event.data)))
      else console.log(JSON.stringify(event.data, null, 2))
    })
    await new Promise(() => undefined)
  })

program
  .command('seek <value>')
  .description('跳转到秒数；+10/-10 表示相对跳转')
  .action(async (value: string) => {
    const relative = value.startsWith('+') || value.startsWith('-')
    output(await withDaemon('seek', { value: Number(value), relative }))
  })

program
  .command('volume <value>')
  .description('设置音量 0-100')
  .action(async (value) => output(await withDaemon('volume', { value: Number(value) })))

const queue = program.command('queue').description('管理播放队列')
queue.command('list').action(async () => {
  const result = await withDaemon<{ songs: Song[]; index: number }>('queue.list')
  output(result, () =>
    result.songs.forEach((song, index) =>
      console.log(`${index === result.index ? '▶' : ' '} ${formatSong(song, index)}`),
    ),
  )
})
queue
  .command('add <id>')
  .action(async (id) => output(await withDaemon('queue.add', { id: Number(id) })))
queue
  .command('remove <index>')
  .action(async (index) => output(await withDaemon('queue.remove', { index: Number(index) })))
queue
  .command('move <from> <to>')
  .action(async (from, to) =>
    output(await withDaemon('queue.move', { from: Number(from), to: Number(to) })),
  )
queue
  .command('play <index>')
  .description('播放队列中的指定索引')
  .action(async (index) => output(await withDaemon('queue.play', { index: Number(index) })))
queue.command('clear').action(async () => output(await withDaemon('queue.clear')))

program
  .command('mode <mode>')
  .description('设置播放模式：sequence、repeat-one、shuffle')
  .action(async (mode) => output(await withDaemon('mode.set', { mode })))

program
  .command('lyrics [id]')
  .description('获取歌词')
  .action(async (id) => {
    const result = await withDaemon<any>('lyrics', id ? { id: Number(id) } : undefined)
    output(result, () =>
      result.lines.forEach((line: any) => {
        console.log(
          `[${line.time.toFixed(2)}] ${line.text}${line.translation ? ` / ${line.translation}` : ''}`,
        )
      }),
    )
  })

program
  .command('spectrum')
  .description('获取当前频谱快照')
  .action(async () => {
    const frame = await withDaemon<SpectrumFrame>('spectrum')
    output(frame, () => {
      const chars = ' ▁▂▃▄▅▆▇█'
      console.log(frame.bins.map((value) => chars[Math.round(value * 8)]).join(''))
    })
  })

const login = program.command('login').description('网易云账号登录')
login
  .command('qr')
  .description('二维码登录')
  .action(async () => {
    if (program.opts().json) throw new Error('二维码登录需要交互式终端，请移除 --json')
    const start = await withDaemon<{ key: string; url: string }>('login.qr.start')
    qrcode.generate(start.url, { small: true }, (code) => console.log(code))
    console.log('请使用网易云音乐 App 扫码确认登录。')
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const result = await withDaemon<{ code: number; message?: string; loggedIn: boolean }>(
        'login.qr.check',
        { key: start.key },
      )
      if (result.loggedIn) return console.log('登录成功。')
      if (result.code === 800) throw new Error('二维码已过期')
    }
    throw new Error('二维码登录超时')
  })
login
  .command('cookie [cookie]')
  .description('手动导入 Cookie，验证账号后持久化保存')
  .action(async (cookieArgument?: string) => {
    const cookie = cookieArgument?.trim() || (await readCookieInput())
    const result = await withDaemon<{
      loggedIn: boolean
      valid: boolean
      persisted: boolean
      profile: { userId: number; nickname: string; vipType: number }
    }>('login.cookie', { cookie })
    output(result, () => {
      console.log(`登录成功：${result.profile.nickname} (${result.profile.userId})`)
      console.log('Cookie 已持久化保存。')
    })
  })
login.command('status').action(async () => output(await withDaemon('login.status')))
login.command('verify').action(async () => output(await withDaemon('login.status')))
login.command('logout').action(async () => output(await withDaemon('logout')))

const library = program.command('library').description('网易云音乐库')
library.command('playlists').action(async () => output(await withDaemon('library.playlists')))
library
  .command('playlist <id>')
  .option('--play', '加载并播放整个歌单')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (id, options) =>
    output(
      await withDaemon(options.play ? 'library.playlist.play' : 'library.playlist', {
        id: Number(id),
        index: Number(options.index),
      }),
    ),
  )
library
  .command('daily')
  .option('--play', '播放全部每日推荐')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (options) =>
    output(
      await withDaemon(options.play ? 'library.daily.play' : 'library.daily', {
        index: Number(options.index),
      }),
    ),
  )
library
  .command('daily-playlists')
  .action(async () => output(await withDaemon('library.daily.playlists')))
library
  .command('fm')
  .option('--play', '进入私人 FM 并自动续取')
  .action(async (options) =>
    output(await withDaemon(options.play ? 'library.fm.play' : 'library.fm')),
  )
library.command('fm-trash').action(async () => output(await withDaemon('library.fm.trash')))
library
  .command('history')
  .option('--play', '播放最近播放列表')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (options) =>
    output(
      await withDaemon(options.play ? 'library.history.play' : 'library.history', {
        index: Number(options.index),
      }),
    ),
  )
library
  .command('history-clear')
  .action(async () => output(await withDaemon('library.history.clear')))
library
  .command('local')
  .option('--play', '播放本地音乐库')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (options) =>
    output(
      await withDaemon(options.play ? 'library.local.play' : 'library.local', {
        index: Number(options.index),
      }),
    ),
  )
library
  .command('local-scan <path>')
  .description('扫描本地音乐文件或目录')
  .action(async (path) => output(await withDaemon('library.local.scan', { path })))
library
  .command('local-remove <index>')
  .action(async (index) =>
    output(await withDaemon('library.local.remove', { index: Number(index) })),
  )

program
  .command('like <id>')
  .option('--remove', '取消喜欢')
  .action(async (id, options) =>
    output(await withDaemon('like', { id: Number(id), liked: !options.remove })),
  )

const scrobble = program.command('scrobble').description('管理网易云听歌上报')
scrobble.command('status').action(async () => {
  const config = await withDaemon<any>('config.get')
  const status = await withDaemon<PlaybackStatus>('status')
  output({ ...config.scrobble, lastScrobble: status.lastScrobble })
})
scrobble.command('enable').action(async () => {
  const config = await withDaemon<any>('config.get')
  output(
    await withDaemon('config.set', {
      patch: { scrobble: { ...config.scrobble, enabled: true, configured: true } },
    }),
  )
})
scrobble.command('disable').action(async () => {
  const config = await withDaemon<any>('config.get')
  output(
    await withDaemon('config.set', {
      patch: { scrobble: { ...config.scrobble, enabled: false, configured: true } },
    }),
  )
})
scrobble
  .command('mode <mode>')
  .description('选择 ncbl 或 legacy 上报方式')
  .action(async (mode) => {
    if (!['ncbl', 'legacy'].includes(mode)) throw new Error('mode 必须是 ncbl 或 legacy')
    const config = await withDaemon<any>('config.get')
    output(
      await withDaemon('config.set', {
        patch: { scrobble: { ...config.scrobble, mode, configured: true } },
      }),
    )
  })

const source = program.command('source').description('音源设置')
source.command('status').action(async () => output(await withDaemon('source.status')))
source
  .command('set [source]')
  .option('--disable', '禁用解灰')
  .action(async (sourceName, options) =>
    output(
      await withDaemon('source.set', {
        source: sourceName || 'auto',
        enabled: !options.disable,
      }),
    ),
  )
source
  .command('test <id>')
  .action(async (id) => output(await withDaemon('source.test', { id: Number(id) })))

const smtc = program.command('smtc').description('管理 Windows 系统媒体控件')
smtc.command('status').action(async () => output(await withDaemon('smtc.status')))
smtc.command('enable').action(async () => output(await withDaemon('smtc.set', { enabled: true })))
smtc.command('disable').action(async () => output(await withDaemon('smtc.set', { enabled: false })))

program
  .command('doctor')
  .description('检查运行环境')
  .action(async () => output(await withDaemon('doctor')))

const daemon = program.command('daemon').description('管理后台播放器')
daemon.command('start').action(async () => output(await ensureDaemon()))
daemon.command('status').action(async () => output(await requestDaemon('ping')))
daemon.command('stop').action(async () => output(await requestDaemon('shutdown')))
daemon.command('restart').action(async () => {
  await requestDaemon('shutdown').catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 300))
  output(await ensureDaemon())
})

program.command('mcp').description('启动 stdio MCP Server').action(runMcpServer)

const main = async () => {
  if (process.argv.length === 2) {
    await ensureDaemon()
    if (!process.stdout.isTTY) return output(await requestDaemon<PlaybackStatus>('status'))
    render(React.createElement(NowPlaying))
    return
  }
  await program.parseAsync(process.argv)
}

try {
  await main()
} catch (error) {
  const appError = toAppError(error)
  const failure: OutputEnvelope = {
    ok: false,
    error: { code: appError.code, message: appError.message, details: appError.details },
    meta: { version: VERSION, timestamp: new Date().toISOString() },
  }
  if (program.opts().json) console.log(JSON.stringify(failure))
  else console.error(`${appError.code}: ${appError.message}`)
  process.exitCode = appError.code === 'INVALID_ARGUMENT' ? 2 : 1
}
