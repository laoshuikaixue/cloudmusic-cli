import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from '../core/paths.js'
import type { PlaybackStatus } from '../core/types.js'

export type SmtcEvent =
  { event: 'play' | 'pause' | 'stop' | 'next' | 'previous' } | { event: 'seek'; positionMs: number }

const executableCandidates = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return [
    process.env.CLOUDMUSIC_SMTC_PATH,
    join(moduleDir, 'native', 'cloudmusic-smtc.exe'),
    join(process.cwd(), 'dist', 'native', 'cloudmusic-smtc.exe'),
    join(process.cwd(), 'native', 'smtc', 'target', 'release', 'cloudmusic-smtc.exe'),
  ].filter((value): value is string => Boolean(value))
}

export class SmtcBridge {
  private process?: ChildProcessWithoutNullStreams
  private lastSongId?: number
  private buffer = ''
  private executable?: string

  async findExecutable() {
    for (const candidate of executableCandidates()) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // 继续尝试下一个候选位置。
      }
    }
    return undefined
  }

  async start(onEvent: (event: SmtcEvent) => void) {
    if (process.platform !== 'win32' || this.process) return false
    this.executable = await this.findExecutable()
    if (!this.executable) return false
    this.process = spawn(this.executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk
      while (true) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        try {
          onEvent(JSON.parse(line) as SmtcEvent)
        } catch {
          // 忽略桥接器的非协议输出。
        }
      }
    })
    this.process.once('close', () => {
      this.process = undefined
      this.lastSongId = undefined
    })
    return true
  }

  private send(payload: unknown) {
    if (this.process?.stdin.writable) this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  async sync(status: PlaybackStatus) {
    if (!this.process) return
    const song = status.song
    if (song && song.id !== this.lastSongId) {
      this.lastSongId = song.id
      let coverPath: string | undefined
      if (song.cover) {
        try {
          const response = await fetch(song.cover)
          if (response.ok) {
            await mkdir(dirname(paths.smtcCoverFile), { recursive: true })
            await writeFile(paths.smtcCoverFile, Buffer.from(await response.arrayBuffer()))
            coverPath = paths.smtcCoverFile
          }
        } catch {
          // 封面失败不影响 SMTC 文本和控制。
        }
      }
      this.send({
        type: 'metadata',
        title: song.name,
        artist: song.artists.map((artist) => artist.name).join(' / '),
        album: song.album.name,
        coverPath,
        id: song.id,
      })
    }
    this.send({ type: 'state', playing: status.state === 'playing' })
    this.send({
      type: 'timeline',
      positionMs: status.position * 1000,
      durationMs: status.duration * 1000,
    })
    this.send({
      type: 'mode',
      shuffle: status.mode === 'shuffle',
      repeat: status.mode === 'repeat-one' ? 'track' : status.mode === 'sequence' ? 'list' : 'none',
    })
  }

  status() {
    return {
      supported: process.platform === 'win32',
      available: Boolean(this.executable),
      running: Boolean(this.process),
      executable: this.executable,
    }
  }

  stop() {
    this.send({ type: 'shutdown' })
    this.process?.stdin.end()
    this.process?.kill()
    this.process = undefined
    this.lastSongId = undefined
  }
}
