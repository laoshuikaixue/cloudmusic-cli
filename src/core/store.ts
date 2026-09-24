import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pickValidConfigPatch, sanitizeConfigPatch } from './config.js'
import {
  addListenedSeconds,
  emptyLocalStats,
  pruneLocalStats,
  type LocalPlayStats,
} from './local-stats.js'
import { paths } from './paths.js'
import type { AppConfig, ConfigPatch, HistoryEntry, QueueSnapshot, Song } from './types.js'

/** 本地听歌统计保留的天数 */
const LOCAL_STATS_DAYS = 365

const defaultConfig: AppConfig = {
  quality: 'exhigh',
  qualityFallback: true,
  skipOnError: true,
  player: {
    speed: 1,
    replayGain: 'off',
    replayGainPreamp: 0,
    fadeMs: 0,
  },
  volume: 80,
  mode: 'sequence',
  allowTrial: false,
  unblock: { enabled: true, source: 'auto' },
  binaries: {},
  scrobble: { enabled: true, mode: 'ncbl', configured: false },
  smtc: { enabled: process.platform === 'win32' },
  classLink: { enabled: false, port: 38973 },
  lyrics: {
    upgrade: true,
    enableTtml: true,
    enableQrc: true,
    amllDbServer: 'https://amlldb.bikonoo.com/%p/%s.ttml',
    display: 'both',
    karaoke: true,
    background: true,
    offsetMs: 0,
  },
}

const ensureParent = async (file: string) => mkdir(dirname(file), { recursive: true })

const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

const writeJson = async (file: string, value: unknown, sensitive = false) => {
  await ensureParent(file)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: sensitive ? 0o600 : 0o644,
  })
  await rename(temporary, file)
  if (sensitive && process.platform !== 'win32') await chmod(file, 0o600)
}

/** 分组深合并，未出现在补丁里的字段保持原值 */
const mergeConfig = (base: AppConfig, patch: ConfigPatch): AppConfig => ({
  ...base,
  ...patch,
  player: { ...base.player, ...patch.player },
  unblock: { ...base.unblock, ...patch.unblock },
  binaries: { ...base.binaries, ...patch.binaries },
  scrobble: { ...base.scrobble, ...patch.scrobble },
  smtc: { ...base.smtc, ...patch.smtc },
  classLink: { ...base.classLink, ...patch.classLink },
  lyrics: { ...base.lyrics, ...patch.lyrics },
})

export class AppStore {
  private config: AppConfig = structuredClone(defaultConfig)
  private localStats: LocalPlayStats = emptyLocalStats()
  private cookie = ''
  private classLinkToken = ''

  async load() {
    const stored = await readJson<Partial<AppConfig>>(paths.configFile, {})
    this.config = mergeConfig(defaultConfig, pickValidConfigPatch(stored))
    // 早期开发版没有设置页，旧配置中的 enabled=false 只是旧默认值，不代表用户选择。
    if (stored.scrobble && stored.scrobble.configured === undefined) {
      this.config.scrobble.enabled = true
    }
    const auth = await readJson<{ cookie?: string; classLinkToken?: string }>(paths.authFile, {})
    this.cookie = auth.cookie || ''
    this.classLinkToken = auth.classLinkToken || ''
    this.localStats = pruneLocalStats(
      await readJson<LocalPlayStats>(paths.localStatsFile, emptyLocalStats()),
      LOCAL_STATS_DAYS,
    )
  }

  getLocalStats() {
    return structuredClone(this.localStats)
  }

  /** 记录一段实际收听时长并落盘，按天累计 */
  async recordLocalStats(song: Song, seconds: number, at = Date.now()) {
    const next = addListenedSeconds(this.localStats, song, seconds, at)
    if (next === this.localStats) return false
    this.localStats = pruneLocalStats(next, LOCAL_STATS_DAYS)
    await writeJson(paths.localStatsFile, this.localStats)
    return true
  }

  getConfig() {
    return structuredClone(this.config)
  }

  async updateConfig(patch: ConfigPatch) {
    this.config = mergeConfig(this.config, sanitizeConfigPatch(patch))
    await writeJson(paths.configFile, this.config)
    return this.getConfig()
  }

  getCookie() {
    return this.cookie
  }

  async setCookie(cookie: string) {
    this.cookie = cookie
    await this.saveAuth()
  }

  async clearCookie() {
    await this.setCookie('')
  }

  getClassLinkToken() {
    return this.classLinkToken
  }

  async setClassLinkToken(token: string) {
    this.classLinkToken = token
    await this.saveAuth()
  }

  async clearClassLinkToken() {
    await this.setClassLinkToken('')
  }

  loadSession() {
    return readJson<QueueSnapshot>(paths.sessionFile, { songs: [], index: -1 })
  }

  saveSession(session: QueueSnapshot) {
    return writeJson(paths.sessionFile, session)
  }

  loadHistory() {
    return readJson<HistoryEntry[]>(paths.historyFile, [])
  }

  saveHistory(history: HistoryEntry[]) {
    return writeJson(paths.historyFile, history.slice(0, 500))
  }

  private saveAuth() {
    return writeJson(
      paths.authFile,
      { cookie: this.cookie, classLinkToken: this.classLinkToken },
      true,
    )
  }
}
