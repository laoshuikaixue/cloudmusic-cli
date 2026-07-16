import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from './paths.js'
import type { AppConfig, HistoryEntry, QueueSnapshot } from './types.js'

const defaultConfig: AppConfig = {
  quality: 'exhigh',
  volume: 80,
  mode: 'sequence',
  allowTrial: false,
  unblock: { enabled: true, source: 'auto' },
  binaries: {},
  scrobble: { enabled: true, mode: 'ncbl', configured: false },
  smtc: { enabled: process.platform === 'win32' },
  classLink: { enabled: false, port: 50064 },
  lyrics: {
    upgrade: true,
    enableTtml: true,
    enableQrc: true,
    amllDbServer: 'https://amlldb.bikonoo.com/%p/%s.ttml',
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

export class AppStore {
  private config: AppConfig = structuredClone(defaultConfig)
  private cookie = ''
  private classLinkToken = ''

  async load() {
    const stored = await readJson<Partial<AppConfig>>(paths.configFile, {})
    this.config = {
      ...defaultConfig,
      ...stored,
      unblock: { ...defaultConfig.unblock, ...stored.unblock },
      binaries: { ...defaultConfig.binaries, ...stored.binaries },
      scrobble: { ...defaultConfig.scrobble, ...stored.scrobble },
      smtc: { ...defaultConfig.smtc, ...stored.smtc },
      classLink: { ...defaultConfig.classLink, ...stored.classLink },
      lyrics: { ...defaultConfig.lyrics, ...stored.lyrics },
    }
    // 早期开发版没有设置页，旧配置中的 enabled=false 只是旧默认值，不代表用户选择。
    if (stored.scrobble && stored.scrobble.configured === undefined) {
      this.config.scrobble.enabled = true
    }
    const auth = await readJson<{ cookie?: string; classLinkToken?: string }>(paths.authFile, {})
    this.cookie = auth.cookie || ''
    this.classLinkToken = auth.classLinkToken || ''
  }

  getConfig() {
    return structuredClone(this.config)
  }

  async updateConfig(patch: Partial<AppConfig>) {
    this.config = {
      ...this.config,
      ...patch,
      unblock: { ...this.config.unblock, ...patch.unblock },
      binaries: { ...this.config.binaries, ...patch.binaries },
      scrobble: { ...this.config.scrobble, ...patch.scrobble },
      smtc: { ...this.config.smtc, ...patch.smtc },
      classLink: { ...this.config.classLink, ...patch.classLink },
      lyrics: { ...this.config.lyrics, ...patch.lyrics },
    }
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
