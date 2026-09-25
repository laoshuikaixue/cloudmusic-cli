#!/usr/bin/env node
import { Command } from 'commander'
import {
  ensureDaemon,
  isDaemonConnectionError,
  requestDaemon,
  subscribeDaemon,
} from './ipc/client.js'
import { AppError, toAppError } from './core/errors.js'
import {
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
  QUALITY_LEVELS,
  isQualityLevel,
} from './core/config.js'
import { formatSleepRemaining } from './daemon/sleep.js'
import type { LocalStatsSummary } from './core/local-stats.js'
import { VERSION } from './version.js'
import type {
  AppConfig,
  ClassLinkStatus,
  CommentPage,
  CollectionSummary,
  ConfigPatch,
  ListenStats,
  LyricResult,
  OutputEnvelope,
  PlaybackStatus,
  PlaylistSummary,
  RecentPlayEntry,
  RecentResourceEntry,
  RadioCategory,
  SigninOverview,
  SigninResult,
  Song,
  SpectrumFrame,
  TodayListenSong,
} from './core/types.js'

// React 19 开发构建每次渲染都会写入 performance.measure 条目，Node 的 User Timing
// 时间线永不自动清理，TUI 以 20fps 渲染时会在数十分钟内累积数 GB 堆内存并 OOM。
// CLI 是终端应用而非 React 开发环境，必须在动态加载 react/ink 之前强制生产构建。
if (process.env.NODE_ENV !== 'production') process.env.NODE_ENV = 'production'

if (process.argv[2] === '__daemon') {
  const { runDaemonServer } = await import('./ipc/server.js')
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

const printCollections = (items: CollectionSummary[]) =>
  output(items, () =>
    items.forEach((item, index) =>
      console.log(
        `${index + 1}. ${item.name}${item.subtitle ? ` — ${item.subtitle}` : ''}${
          item.count ? ` · ${item.count} ${item.countUnit || '首'}` : ''
        } [${item.id}]`,
      ),
    ),
  )

const readSecretInput = async (prompt: string, jsonHint: string) => {
  if (!process.stdin.isTTY) {
    let value = ''
    for await (const chunk of process.stdin) value += chunk.toString()
    return value.trim()
  }
  if (program.opts().json) {
    throw new Error(jsonHint)
  }
  if (!process.stdin.setRawMode) {
    throw new Error('当前终端不支持隐藏输入，请通过 stdin 提供')
  }

  process.stderr.write(prompt)
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
          reject(new Error('已取消输入'))
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

const readCookieInput = () =>
  readSecretInput(
    '请粘贴网易云 Cookie（输入内容已隐藏，回车确认）：',
    'JSON 模式下请通过参数或 stdin 提供 Cookie',
  )

const readClassLinkTokenInput = () =>
  readSecretInput(
    '请粘贴 ClassLink 连接令牌（输入内容已隐藏，回车确认）：',
    'JSON 模式下请通过参数或 stdin 提供 ClassLink 连接令牌',
  )

program
  .command('search <keywords>')
  .description('搜索歌曲、歌单、专辑、歌手或电台')
  .option('-l, --limit <number>', '返回数量', '20')
  .option('-t, --type <type>', '搜索类型：song、playlist、album、artist、radio', 'song')
  .action(async (keywords, options) => {
    const type = String(options.type)
    if (!['song', 'playlist', 'album', 'artist', 'radio'].includes(type)) {
      throw new Error('type 必须是 song、playlist、album、artist 或 radio')
    }
    if (type === 'song') {
      const result = await withDaemon<{ songs: Song[]; total: number }>('search', {
        keywords,
        limit: Number(options.limit),
      })
      return output(result, () =>
        result.songs.forEach((song, index) => console.log(formatSong(song, index))),
      )
    }
    if (type === 'playlist') {
      const result = await withDaemon<{ items: PlaylistSummary[]; total: number }>(
        'search.playlists',
        { keywords, limit: Number(options.limit) },
      )
      return output(result, () =>
        result.items.forEach((item, index) =>
          console.log(`${index + 1}. ${item.name} · ${item.trackCount} 首 [${item.id}]`),
        ),
      )
    }
    const result = await withDaemon<{ items: CollectionSummary[]; total: number }>(
      type === 'album' ? 'search.albums' : type === 'radio' ? 'search.radios' : 'search.artists',
      { keywords, limit: Number(options.limit) },
    )
    return output(result, () =>
      result.items.forEach((item, index) =>
        console.log(
          `${index + 1}. ${item.name}${item.subtitle ? ` — ${item.subtitle}` : ''}${
            item.count ? ` · ${item.count} ${item.countUnit || '首'}` : ''
          } [${item.id}]`,
        ),
      ),
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
  .command('quit')
  .description('彻底退出播放器并关闭 daemon、mpv、FFmpeg 和 SMTC')
  .action(async () => {
    try {
      output(await requestDaemon('shutdown'))
    } catch (error) {
      if (!isDaemonConnectionError(error)) throw error
      output({ shuttingDown: false, alreadyStopped: true })
    }
  })

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
  .command('seek [value]')
  .description('跳转到秒数；+10/-10 表示相对跳转；--chorus 跳到副歌')
  .option('--chorus', '跳转到当前歌曲的副歌开始处')
  .action(async (value: string | undefined, options) => {
    if (options.chorus) return output(await withDaemon('seek.chorus'))
    if (value === undefined) throw new Error('请提供目标秒数或使用 --chorus')
    const relative = value.startsWith('+') || value.startsWith('-')
    output(await withDaemon('seek', { value: Number(value), relative }))
  })

program
  .command('volume <value>')
  .description('设置音量 0-100')
  .action(async (value) => output(await withDaemon('volume', { value: Number(value) })))

program
  .command('speed [value]')
  .description(`查看或设置播放倍速（${MIN_PLAYBACK_SPEED}-${MAX_PLAYBACK_SPEED}），off 恢复 1.0`)
  .action(async (value) => {
    if (value === undefined) {
      const config = await withDaemon<AppConfig>('config.get')
      return output({ speed: config.player.speed }, () =>
        console.log(`当前倍速：${config.player.speed}x`),
      )
    }
    if (!['off'].includes(value) && !Number.isFinite(Number(value))) {
      throw new AppError('INVALID_ARGUMENT', '倍速必须是数字或 off')
    }
    output(await withDaemon('speed.set', { value: value === 'off' ? 1 : Number(value) }))
  })

program
  .command('sleep [value]')
  .description('睡眠定时：分钟数开始倒计时，off 取消，--song-end 播完当前曲停止')
  .option('--song-end', '播完当前歌曲后停止播放')
  .action(async (value, options) => {
    if (options.songEnd) return output(await withDaemon('sleep.set', { songEnd: true }))
    if (value === undefined) {
      const status = await withDaemon<PlaybackStatus>('status')
      return output({ sleep: status.sleep ?? null }, () => {
        if (!status.sleep) return console.log('未设置睡眠定时')
        if (status.sleep.mode === 'song-end') return console.log('将在当前歌曲结束后停止')
        console.log(`剩余 ${formatSleepRemaining(status.sleep.remainingSeconds || 0)} 后暂停播放`)
      })
    }
    if (value === 'off') return output(await withDaemon('sleep.set', {}))
    const minutes = Number(value)
    if (!Number.isFinite(minutes)) {
      throw new AppError('INVALID_ARGUMENT', '睡眠定时需要分钟数、off 或 --song-end')
    }
    output(await withDaemon('sleep.set', { minutes }))
  })

const player = program.command('player').description('播放音效：倍速、响度归一与淡入淡出')
player
  .command('status')
  .action(async () => output((await withDaemon<AppConfig>('config.get')).player))
player
  .command('replay-gain <mode>')
  .description('响度归一：off / track / album，下一首起生效')
  .action(async (mode) =>
    output(await withDaemon('config.set', { patch: { player: { replayGain: mode } } })),
  )
player
  .command('preamp <db>')
  .description('ReplayGain 前置增益（-12 到 12 dB），下一首起生效')
  .action(async (db) =>
    output(await withDaemon('config.set', { patch: { player: { replayGainPreamp: Number(db) } } })),
  )
player
  .command('fade <ms>')
  .description('淡入淡出时长（0 关闭，最大 3000 毫秒）')
  .action(async (ms) =>
    output(await withDaemon('config.set', { patch: { player: { fadeMs: Number(ms) } } })),
  )

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
  .command('next <id>')
  .description('将歌曲设为下一首播放')
  .action(async (id) => output(await withDaemon('queue.next', { id: Number(id) })))
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
  .command('similar [id]')
  .description('基于当前歌曲或指定 ID 获取相似推荐')
  .option('-t, --type <type>', '推荐类型：song、playlist、artist', 'song')
  .option('-l, --limit <number>', '返回数量', '20')
  .option('--play', '用相似歌曲替换队列并播放')
  .action(async (id, options) => {
    const type = String(options.type)
    if (!['song', 'playlist', 'artist'].includes(type)) {
      throw new Error('type 必须是 song、playlist 或 artist')
    }
    const params = {
      ...(id ? { id: Number(id) } : {}),
      limit: Number(options.limit),
    }
    if (type === 'song') {
      if (options.play) return output(await withDaemon('similar.play', params))
      const result = await withDaemon<{ songs: Song[] }>('similar.songs', params)
      return output(result, () =>
        result.songs.forEach((song, index) => console.log(formatSong(song, index))),
      )
    }
    if (options.play) throw new Error('--play 仅支持 song 类型')
    if (type === 'playlist') {
      const result = await withDaemon<{ items: PlaylistSummary[] }>('similar.playlists', params)
      return output(result, () =>
        result.items.forEach((item, index) =>
          console.log(`${index + 1}. ${item.name} · ${item.trackCount} 首 [${item.id}]`),
        ),
      )
    }
    const result = await withDaemon<{ items: CollectionSummary[] }>('similar.artists', params)
    output(result, () =>
      result.items.forEach((item, index) =>
        console.log(
          `${index + 1}. ${item.name}${item.subtitle ? ` — ${item.subtitle}` : ''} [${item.id}]`,
        ),
      ),
    )
  })

program
  .command('stats')
  .description('听歌足迹：累计时长与听歌习惯分布')
  .option('--month', '查看月报告')
  .option('--year', '查看年报告')
  .option('--today', '查看今日听歌歌曲')
  .option('--local', '使用本机播放记录统计，不依赖服务端报告接口')
  .action(async (options) => {
    if (options.local) {
      const type = options.year
        ? 'year'
        : options.month
          ? 'month'
          : options.today
            ? 'today'
            : 'week'
      const summary = await withDaemon<LocalStatsSummary>('stats.local', { type })
      return output(summary, () => {
        console.log(
          `本机记录 ${summary.from} ~ ${summary.to}：${Math.round(summary.totalSeconds / 60)} 分钟 · ${summary.activeDays} 天 · ${summary.songCount} 首`,
        )
        if (summary.topSongs.length) {
          console.log('收听 TOP 歌曲：')
          summary.topSongs.forEach((item, index) =>
            console.log(
              `  ${index + 1}. ${item.song.name} — ${item.song.artists.join(' / ')} · ${Math.round(item.seconds / 60)} 分钟 [${item.song.id}]`,
            ),
          )
        }
        if (summary.daily.length) {
          console.log('每日时长：')
          summary.daily.forEach((day) =>
            console.log(`  ${day.date}  ${Math.round(day.seconds / 60)} 分钟`),
          )
        }
      })
    }
    if (options.today) {
      const songs = await withDaemon<TodayListenSong[]>('stats.today')
      return output(songs, () =>
        songs.forEach((song, index) =>
          console.log(
            `${String(index + 1).padStart(2, ' ')}. ${song.name} — ${song.artists.join(' / ')} · ${new Date(song.lastPlayTime).toLocaleTimeString()} [${song.id}]`,
          ),
        ),
      )
    }
    const type = options.year ? 'year' : options.month ? 'month' : 'week'
    const stats = await withDaemon<ListenStats>('stats.listen', { type })
    output(stats, () => {
      const { report } = stats
      const rangeName = type === 'year' ? '本年' : type === 'month' ? '本月' : '本周'
      console.log(`累计听歌 ${Math.round(stats.totalPlaySeconds / 3600)} 小时`)
      console.log(
        `${rangeName}听歌 ${report.playMinutes} 分钟 · ${report.listenDays} 天 · ${report.songCount} 首`,
      )
      if (report.dailyDurations.length) {
        console.log('每日时长：')
        report.dailyDurations.forEach((day) => console.log(`  ${day.date}  ${day.minutes} 分钟`))
      }
      if (report.topSongs.length) {
        console.log('收听 TOP 歌曲：')
        report.topSongs.forEach((song, index) =>
          console.log(
            `  ${index + 1}. ${song.name}${song.text ? ` · ${song.text}` : ''} [${song.id}]`,
          ),
        )
      }
      if (report.topArtists.length) {
        console.log('收听 TOP 歌手：')
        report.topArtists.forEach((artist, index) =>
          console.log(
            `  ${index + 1}. ${artist.name}${artist.text ? ` · ${artist.text}` : ''} [${artist.id}]`,
          ),
        )
      }
      if (report.styles.length) {
        console.log(`风格分布：${report.styles.map((s) => `${s.name} ${s.percent}%`).join(' · ')}`)
      }
      if (report.languages.length) {
        console.log(
          `语种分布：${report.languages.map((l) => `${l.language} ${l.percent}%`).join(' · ')}`,
        )
      }
      if (report.ages.length) {
        console.log(`年代分布：${report.ages.map((a) => `${a.age}s ${a.songCount}首`).join(' · ')}`)
      }
    })
  })

program
  .command('signin')
  .description('每日签到（积分 + 云贝）')
  .option('--overview', '查看今日签到状态、连签进度、会员成长值与云贝余额')
  .action(async (options) => {
    if (options.overview) {
      const overview = await withDaemon<SigninOverview>('signin.overview')
      return output(overview, () => {
        console.log(
          `今日签到：${overview.todaySignedIn ? '已签到' : '未签到'} · 近 30 天记录 ${overview.records.filter((item) => item.signed).length} 天`,
        )
        for (const item of overview.progress) {
          console.log(
            `  ${item.description}：${item.currentProgress}（最高 ${item.maxProgressReached}）`,
          )
        }
        if (overview.growth) {
          console.log(
            `会员成长值：Lv.${overview.growth.level}${overview.growth.levelName ? ` ${overview.growth.levelName}` : ''} · ${overview.growth.growthPoint}${overview.growth.maxLevel ? ' · 已满级' : ''}`,
          )
        }
        if (overview.yunbei) {
          console.log(`云贝：${overview.yunbei.balance} · 云贝等级 ${overview.yunbei.level}`)
        }
      })
    }
    const result = await withDaemon<SigninResult>('signin')
    output(result, () => {
      for (const item of [result.daily, result.yunbei]) {
        const state = item.success ? (item.repeated ? '已签到' : '签到成功') : '失败'
        const point = item.point !== undefined ? ` (+${item.point})` : ''
        console.log(`${item.task}：${state}${point}${item.success ? '' : ` · ${item.message}`}`)
      }
    })
  })

program
  .command('lyrics [id]')
  .description('获取歌词')
  .option('--no-upgrade', '只返回网易云官方歌词，不尝试 TTML/QRC 升级')
  .option('--words', '显示逐字起止时间')
  .action(async (id, options) => {
    const result = await withDaemon<LyricResult>('lyrics', {
      ...(id ? { id: Number(id) } : {}),
      upgrade: options.upgrade,
    })
    output(result, () => {
      console.log(
        `${result.format.toUpperCase()} · ${result.source}${result.upgraded ? ' · upgraded' : ''}`,
      )
      result.lines.forEach((line: any) => {
        const wordText = options.words
          ? line.words
              ?.map(
                (word: any) =>
                  `<${word.startTime.toFixed(3)}-${word.endTime.toFixed(3)}>${word.text}`,
              )
              .join('')
          : undefined
        console.log(
          `[${line.time.toFixed(2)}] ${line.isBackground ? '↳ ' : line.isDuet ? '↔ ' : ''}${wordText || line.text}${line.translation ? ` / ${line.translation}` : ''}${line.romanization ? ` / ${line.romanization}` : ''}`,
        )
      })
    })
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
    const qrcode = (await import('qrcode-terminal')).default
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
library
  .command('profile [uid]')
  .description('查看当前账号或指定用户的网易云资料')
  .action(async (uid) =>
    output(await withDaemon('library.profile', uid === undefined ? {} : { uid: Number(uid) })),
  )
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
  .command('playlist-subscribe <id>')
  .description('收藏或取消收藏网易云歌单')
  .option('--remove', '取消收藏')
  .action(async (id, options) =>
    output(
      await withDaemon('library.playlist.subscribe', {
        id: Number(id),
        subscribed: !options.remove,
      }),
    ),
  )
library
  .command('playlist-create <name>')
  .description('创建网易云歌单')
  .option('--private', '创建隐私歌单')
  .action(async (name, options) =>
    output(await withDaemon('library.playlist.create', { name, private: options.private })),
  )
library
  .command('playlist-rename <id> <name>')
  .description('重命名自建歌单')
  .action(async (id, name) =>
    output(await withDaemon('library.playlist.rename', { id: Number(id), name })),
  )
library
  .command('playlist-delete <id>')
  .description('删除自建歌单')
  .action(async (id) => output(await withDaemon('library.playlist.delete', { id: Number(id) })))
library
  .command('playlist-tracks <id> <trackIds...>')
  .description('向自建歌单添加歌曲，或通过 --remove 移除歌曲')
  .option('--remove', '从歌单移除歌曲')
  .action(async (id, trackIds, options) =>
    output(
      await withDaemon('library.playlist.tracks', {
        id: Number(id),
        trackIds: trackIds.map(Number),
        operation: options.remove ? 'del' : 'add',
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
  .command('personalized')
  .description('获取通用推荐歌单')
  .option('--limit <limit>', '返回数量', '30')
  .action(async (options) =>
    output(await withDaemon('library.discover.recommended', { limit: Number(options.limit) })),
  )
library
  .command('discover')
  .description('浏览歌单广场')
  .option('--cat <category>', '歌单分类', '全部')
  .option('--order <order>', 'hot 或 new', 'hot')
  .option('--limit <limit>', '返回数量', '50')
  .option('--offset <offset>', '分页偏移', '0')
  .action(async (options) =>
    output(
      await withDaemon('library.discover.playlists', {
        cat: options.cat,
        order: options.order,
        limit: Number(options.limit),
        offset: Number(options.offset),
      }),
    ),
  )
library
  .command('highquality')
  .description('浏览精品歌单')
  .option('--cat <category>', '歌单分类', '全部')
  .option('--limit <limit>', '返回数量', '50')
  .option('--before <timestamp>', '上一页末项更新时间', '0')
  .action(async (options) =>
    output(
      await withDaemon('library.discover.highquality', {
        cat: options.cat,
        limit: Number(options.limit),
        before: Number(options.before),
      }),
    ),
  )
library.command('toplists').action(async () => output(await withDaemon('library.toplists')))
library
  .command('toplist <id>')
  .option('--play', '播放整个官方榜单')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (id, options) =>
    output(
      await withDaemon(options.play ? 'library.toplist.play' : 'library.toplist', {
        id: Number(id),
        index: Number(options.index),
      }),
    ),
  )
library
  .command('new')
  .description('查看或播放新歌速递：0 全部，7 华语，96 欧美，8 日本，16 韩国')
  .option('--area <area>', '地区 ID', '0')
  .option('--play', '播放该地区新歌队列')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (options) =>
    output(
      await withDaemon(options.play ? 'library.new.play' : 'library.new', {
        area: Number(options.area),
        index: Number(options.index),
      }),
    ),
  )
library
  .command('fm')
  .option('--play', '进入私人 FM 并自动续取')
  .action(async (options) =>
    output(await withDaemon(options.play ? 'library.fm.play' : 'library.fm')),
  )
library.command('fm-trash').action(async () => output(await withDaemon('library.fm.trash')))
library
  .command('heart [seed]')
  .description('获取或播放心动模式智能推荐队列')
  .option('--play', '进入心动模式并播放')
  .action(async (seed, options) =>
    output(
      await withDaemon(options.play ? 'library.heart.play' : 'library.heart', {
        ...(seed === undefined ? {} : { id: Number(seed) }),
      }),
    ),
  )
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
  .command('cloud')
  .option('--play', '播放音乐云盘全部歌曲')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (options) =>
    output(
      await withDaemon(options.play ? 'library.cloud.play' : 'library.cloud', {
        index: Number(options.index),
      }),
    ),
  )
library.command('albums').action(async () => output(await withDaemon('library.albums')))
library
  .command('album <id>')
  .option('--play', '播放整张专辑')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (id, options) =>
    output(
      await withDaemon(options.play ? 'library.album.play' : 'library.album', {
        id: Number(id),
        index: Number(options.index),
      }),
    ),
  )
library.command('artists').action(async () => output(await withDaemon('library.artists')))
library
  .command('artist <id>')
  .option('--play', '播放该歌手全部热门歌曲')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (id, options) =>
    output(
      await withDaemon(options.play ? 'library.artist.play' : 'library.artist', {
        id: Number(id),
        index: Number(options.index),
      }),
    ),
  )
library
  .command('dj <id>')
  .description('播客电台的节目列表（节目按普通歌曲取源）')
  .option('--play', '播放该电台已加载的节目')
  .option('--name <name>', '电台名称，用于队列标题')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (id, options) =>
    output(
      await withDaemon(options.play ? 'library.dj.play' : 'library.dj', {
        id: Number(id),
        name: typeof options.name === 'string' ? options.name : '',
        index: Number(options.index),
      }),
    ),
  )
library
  .command('dj-subscribed')
  .description('我订阅的播客电台')
  .option('--limit <limit>', '返回数量', '30')
  .action(async (options) =>
    printCollections(
      await withDaemon<CollectionSummary[]>('library.dj.subscribed', {
        limit: Number(options.limit),
      }),
    ),
  )
library
  .command('dj-hot')
  .description('热门播客电台')
  .option('--limit <limit>', '返回数量', '30')
  .action(async (options) =>
    printCollections(
      await withDaemon<CollectionSummary[]>('library.dj.hot', { limit: Number(options.limit) }),
    ),
  )
library
  .command('dj-categories')
  .description('播客电台分类列表')
  .action(async () => {
    const categories = await withDaemon<RadioCategory[]>('library.dj.categories')
    output(categories, () =>
      categories.forEach((category, index) =>
        console.log(`${index + 1}. ${category.name} [${category.id}]`),
      ),
    )
  })
library
  .command('dj-category <cateId>')
  .description('指定分类下的热门播客电台，分类 ID 见 library dj-categories')
  .option('--limit <limit>', '返回数量', '30')
  .action(async (cateId, options) =>
    printCollections(
      await withDaemon<CollectionSummary[]>('library.dj.category', {
        cateId: Number(cateId),
        limit: Number(options.limit),
      }),
    ),
  )
library
  .command('record')
  .option('--week', '查看最近一周排行')
  .option('--play', '播放听歌排行')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (options) =>
    output(
      await withDaemon(options.play ? 'library.record.play' : 'library.record', {
        range: options.week ? 'week' : 'all',
        index: Number(options.index),
      }),
    ),
  )
library
  .command('recent')
  .description('服务端最近播放（跨设备）')
  .option('--type <type>', 'song / playlist / album / radio', 'song')
  .option('--play', '播放云端最近播放列表')
  .option('--limit <limit>', '返回数量', '50')
  .option('--index <index>', '从指定索引开始播放', '0')
  .action(async (options) => {
    const type = String(options.type || 'song')
    if (!['song', 'playlist', 'album', 'radio'].includes(type)) {
      throw new AppError('INVALID_ARGUMENT', '--type 只能是 song / playlist / album / radio')
    }
    if (options.play && type !== 'song') {
      throw new AppError('INVALID_ARGUMENT', `--play 仅支持歌曲，${type} 请用对应的库命令播放`)
    }
    if (type !== 'song') {
      const method =
        type === 'playlist'
          ? 'library.recent.playlists'
          : type === 'album'
            ? 'library.recent.albums'
            : 'library.recent.radios'
      const entries = await withDaemon<RecentResourceEntry[]>(method, {
        limit: Number(options.limit),
      })
      return output(entries, () =>
        entries.forEach((entry, index) =>
          console.log(
            `${String(index + 1).padStart(2, ' ')}. ${entry.name}${entry.count !== undefined ? ` · ${entry.count}` : ''} · ${new Date(entry.playTime).toLocaleString()} [${entry.id}]`,
          ),
        ),
      )
    }
    if (options.play) {
      return output(
        await withDaemon('library.recent.play', {
          limit: Number(options.limit),
          index: Number(options.index),
        }),
      )
    }
    const entries = await withDaemon<RecentPlayEntry[]>('library.recent', {
      limit: Number(options.limit),
    })
    output(entries, () =>
      entries.forEach((entry, index) =>
        console.log(
          `${formatSong(entry.song, index)} · ${new Date(entry.playTime).toLocaleString()}${entry.os ? ` · ${entry.os}` : ''}`,
        ),
      ),
    )
  })

program
  .command('like <id>')
  .option('--remove', '取消喜欢')
  .action(async (id, options) =>
    output(await withDaemon('like', { id: Number(id), liked: !options.remove })),
  )

program
  .command('comments [id]')
  .description('查看当前歌曲或指定歌曲的评论')
  .option('-l, --limit <number>', '返回数量', '20')
  .option('-o, --offset <number>', '偏移量', '0')
  .action(async (id, options) => {
    const result = await withDaemon<CommentPage>('comments.song', {
      ...(id === undefined ? {} : { id: Number(id) }),
      limit: Number(options.limit),
      offset: Number(options.offset),
    })
    output(result, () => {
      const rows = result.hotComments.length ? result.hotComments : result.comments
      for (const comment of rows) {
        console.log(`${comment.user.nickname} · ♡ ${comment.likedCount}`)
        console.log(comment.content)
        console.log('')
      }
    })
  })

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
  .command('quality [level]')
  .description(`查看或设置播放音质，可选 ${QUALITY_LEVELS.join(' / ')}`)
  .option('--fallback <state>', 'on 或 off，控制音质不可用时是否自动降级')
  .action(async (level, options) => {
    if (options.fallback !== undefined && !['on', 'off'].includes(options.fallback)) {
      throw new AppError('INVALID_ARGUMENT', '--fallback 只接受 on 或 off')
    }
    const patch: ConfigPatch = {}
    if (level !== undefined) {
      if (!isQualityLevel(level)) {
        throw new AppError('INVALID_ARGUMENT', `音质必须是 ${QUALITY_LEVELS.join(' / ')} 之一`)
      }
      patch.quality = level
    }
    if (options.fallback !== undefined) patch.qualityFallback = options.fallback === 'on'
    if (!Object.keys(patch).length) {
      const config = await withDaemon<AppConfig>('config.get')
      return output(
        {
          quality: config.quality,
          qualityFallback: config.qualityFallback,
          levels: QUALITY_LEVELS,
        },
        () => {
          console.log(
            `当前音质：${config.quality} · 自动降级：${config.qualityFallback ? '开启' : '关闭'}`,
          )
          console.log(`可选档位：${QUALITY_LEVELS.join(' ')}`)
        },
      )
    }
    output(await withDaemon('config.set', { patch }))
  })
source
  .command('auto-skip <state>')
  .description('取不到音源时是否自动切到下一首：on 或 off')
  .action(async (state) => {
    if (!['on', 'off'].includes(state)) {
      throw new AppError('INVALID_ARGUMENT', 'auto-skip 只接受 on 或 off')
    }
    output(await withDaemon('config.set', { patch: { skipOnError: state === 'on' } }))
  })
source
  .command('test <id>')
  .action(async (id) => output(await withDaemon('source.test', { id: Number(id) })))

const smtc = program.command('smtc').description('管理 Windows 系统媒体控件')
smtc.command('status').action(async () => output(await withDaemon('smtc.status')))
smtc.command('enable').action(async () => output(await withDaemon('smtc.set', { enabled: true })))
smtc.command('disable').action(async () => output(await withDaemon('smtc.set', { enabled: false })))

const classLink = program.command('classlink').description('管理 ClassIsland ClassLink 联动')
classLink
  .command('status')
  .action(async () => output(await withDaemon<ClassLinkStatus>('classlink.status')))
classLink
  .command('connect [token]')
  .description('保存连接令牌并启用 ClassLink；不传参数时使用隐藏输入')
  .option('-p, --port <port>', 'ClassIsland 监听端口')
  .action(async (token, options) => {
    const value = String(token || '').trim() || (await readClassLinkTokenInput())
    output(
      await withDaemon<ClassLinkStatus>('classlink.set', {
        enabled: true,
        token: value,
        port: options.port === undefined ? undefined : Number(options.port),
      }),
    )
  })
classLink
  .command('enable')
  .action(async () => output(await withDaemon<ClassLinkStatus>('classlink.set', { enabled: true })))
classLink
  .command('disable')
  .action(async () =>
    output(await withDaemon<ClassLinkStatus>('classlink.set', { enabled: false })),
  )
classLink
  .command('disconnect')
  .description('禁用 ClassLink 并删除本地连接令牌')
  .action(async () =>
    output(
      await withDaemon<ClassLinkStatus>('classlink.set', {
        enabled: false,
        clearToken: true,
      }),
    ),
  )

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

program
  .command('mcp')
  .description('启动 stdio MCP Server')
  .action(async () => {
    const { runMcpServer } = await import('./mcp/server.js')
    await runMcpServer()
  })

const main = async () => {
  if (process.argv.length === 2) {
    await ensureDaemon()
    if (!process.stdout.isTTY) return output(await requestDaemon<PlaybackStatus>('status'))
    const [
      { default: React },
      { render },
      { NowPlaying },
      { TUI_INCREMENTAL_RENDERING, TUI_MAX_FPS },
    ] = await Promise.all([
      import('react'),
      import('ink'),
      import('./tui/now-playing.js'),
      import('./tui/rendering.js'),
    ])
    process.stdout.write('\u001b[?1049h\u001b[2J\u001b[3J\u001b[H\u001b[?25l')
    try {
      const app = render(React.createElement(NowPlaying), {
        exitOnCtrlC: true,
        incrementalRendering: TUI_INCREMENTAL_RENDERING,
        maxFps: TUI_MAX_FPS,
      })
      await app.waitUntilExit()
    } finally {
      process.stdout.write('\u001b[?25h\u001b[?1049l')
    }
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
