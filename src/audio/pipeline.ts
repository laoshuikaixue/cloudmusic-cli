import { EventEmitter } from 'node:events'
import { unlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createMpvSocketPath } from '../core/paths.js'
import { AppError } from '../core/errors.js'
import type { SpectrumFrame } from '../core/types.js'
import { MpvIpc } from './mpv-ipc.js'
import { SpectrumAnalyzer } from './spectrum.js'

export interface PipelineOptions {
  mpvPath: string
  ffmpegPath: string
  volume: number
  offset?: number
}

export class AudioPipeline extends EventEmitter {
  private mpv?: ChildProcessWithoutNullStreams
  private ffmpeg?: ChildProcessWithoutNullStreams
  private ipc?: MpvIpc
  private analyzer?: SpectrumAnalyzer
  private pollTimer?: NodeJS.Timeout
  private socketPath?: string
  private stopping = false
  private position = 0
  private offset = 0
  private ffmpegError = ''

  async start(url: string, options: PipelineOptions) {
    await this.stop()
    this.stopping = false
    this.offset = options.offset || 0
    this.position = this.offset
    this.ffmpegError = ''
    this.socketPath = createMpvSocketPath()
    if (process.platform !== 'win32') await unlink(this.socketPath).catch(() => undefined)

    const mpvArgs = [
      '--no-video',
      '--really-quiet',
      '--input-terminal=no',
      `--input-ipc-server=${this.socketPath}`,
      '--demuxer=rawaudio',
      '--demuxer-rawaudio-format=s16le',
      '--demuxer-rawaudio-rate=48000',
      '--demuxer-rawaudio-channels=stereo',
      `--volume=${options.volume}`,
      '-',
    ]

    const mpvPath =
      process.platform === 'win32' && options.mpvPath === 'mpv' ? 'mpv.exe' : options.mpvPath
    try {
      this.mpv = spawn(mpvPath, mpvArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw new AppError('MPV_START_FAILED', '无法启动 mpv', String(error))
    }
    const mpvStartup = new Promise<never>((_, reject) => {
      this.mpv?.once('error', (error) => reject(new AppError('MPV_START_FAILED', error.message)))
    })
    this.ipc = new MpvIpc(this.socketPath)
    await Promise.race([this.ipc.connect(), mpvStartup])

    this.analyzer = new SpectrumAnalyzer(this.offset)
    const ffmpegArgs = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      ...(this.offset > 0 ? ['-ss', String(this.offset)] : []),
      '-i',
      url,
      '-vn',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      'pipe:1',
    ]
    try {
      this.ffmpeg = spawn(options.ffmpegPath, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      await this.stop()
      throw new AppError('FFMPEG_START_FAILED', '无法启动 FFmpeg', String(error))
    }

    this.ffmpeg.stderr.on('data', (chunk) => {
      this.ffmpegError = `${this.ffmpegError}${chunk.toString('utf8')}`.slice(-4000)
    })
    this.ffmpeg.stdout.on('data', (chunk: Buffer) => {
      this.analyzer?.push(chunk)
      if (this.mpv && !this.mpv.stdin.destroyed && !this.mpv.stdin.write(chunk)) {
        this.ffmpeg?.stdout.pause()
        this.mpv.stdin.once('drain', () => this.ffmpeg?.stdout.resume())
      }
    })
    this.ffmpeg.once('error', (error) => this.emit('error', error))
    this.ffmpeg.once('close', (code) => {
      this.mpv?.stdin.end()
      if (!this.stopping && code && code !== 0) {
        this.emit(
          'error',
          new AppError('FFMPEG_FAILED', this.ffmpegError || `FFmpeg 退出：${code}`),
        )
      }
    })
    this.mpv.once('close', () => {
      if (!this.stopping) this.emit('ended')
    })

    this.pollTimer = setInterval(async () => {
      try {
        const value = await this.ipc?.command<number>('get_property', 'time-pos')
        if (typeof value === 'number' && Number.isFinite(value)) this.position = this.offset + value
      } catch {
        // 切歌或关闭期间允许短暂读取失败。
      }
    }, 100)
  }

  async pause() {
    await this.ipc?.command('set_property', 'pause', true)
  }

  async resume() {
    await this.ipc?.command('set_property', 'pause', false)
  }

  async setVolume(volume: number) {
    await this.ipc?.command('set_property', 'volume', volume)
  }

  getPosition() {
    return this.position
  }

  getSpectrum(): SpectrumFrame {
    return (
      this.analyzer?.frameAt(this.position) || {
        position: this.position,
        bins: new Array(64).fill(0),
        peak: 0,
      }
    )
  }

  async stop() {
    this.stopping = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.ffmpeg?.stdout.removeAllListeners()
    this.ffmpeg?.kill()
    this.mpv?.stdin.end()
    this.mpv?.kill()
    this.ipc?.close()
    await this.analyzer?.destroy().catch(() => undefined)
    if (this.socketPath && process.platform !== 'win32') {
      await unlink(this.socketPath).catch(() => undefined)
    }
    this.ffmpeg = undefined
    this.mpv = undefined
    this.ipc = undefined
    this.analyzer = undefined
    this.socketPath = undefined
  }
}
