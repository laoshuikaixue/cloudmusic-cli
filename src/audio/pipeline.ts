import { EventEmitter } from 'node:events'
import { unlink } from 'node:fs/promises'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
  private mpv?: ChildProcess
  private ffmpeg?: ChildProcessWithoutNullStreams
  private ipc?: MpvIpc
  private analyzer?: SpectrumAnalyzer
  private pollTimer?: NodeJS.Timeout
  private socketPath?: string
  private stopping = false
  private position = 0
  private offset = 0
  private ffmpegError = ''
  private currentUrl = ''
  private currentOptions?: PipelineOptions
  private transition: Promise<void> = Promise.resolve()

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation)
    this.transition = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  start(url: string, options: PipelineOptions) {
    return this.enqueue(() => this.startInternal(url, options))
  }

  private async startInternal(url: string, options: PipelineOptions) {
    await this.stopInternal()
    this.stopping = false
    this.offset = options.offset || 0
    this.position = this.offset
    this.ffmpegError = ''
    this.currentUrl = url
    this.currentOptions = options
    this.socketPath = createMpvSocketPath()
    if (process.platform !== 'win32') await unlink(this.socketPath).catch(() => undefined)

    const mpvArgs = [
      '--no-video',
      '--really-quiet',
      '--input-terminal=no',
      ...(process.platform === 'win32' ? ['--no-media-controls'] : []),
      `--input-ipc-server=${this.socketPath}`,
      '--audio-buffer=0.05',
      `--volume=${options.volume}`,
      ...(this.offset > 0 ? [`--start=${this.offset}`] : []),
      url,
    ]

    const mpvPath =
      process.platform === 'win32' && options.mpvPath === 'mpv' ? 'mpv.exe' : options.mpvPath
    try {
      this.mpv = spawn(mpvPath, mpvArgs, {
        stdio: 'ignore',
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

    await this.startAnalyzer(url, options.ffmpegPath, this.offset)

    this.mpv.once('close', () => {
      if (!this.stopping) this.emit('ended')
    })

    this.pollTimer = setInterval(async () => {
      try {
        const value = await this.ipc?.command<number>('get_property', 'time-pos')
        if (typeof value === 'number' && Number.isFinite(value)) this.position = value
      } catch {
        // 切歌或关闭期间允许短暂读取失败。
      }
    }, 100)
  }

  private async startAnalyzer(url: string, ffmpegPath: string, offset: number) {
    this.ffmpeg?.stdout.removeAllListeners()
    this.ffmpeg?.removeAllListeners()
    this.ffmpeg?.kill()
    await this.analyzer?.destroy().catch(() => undefined)
    this.ffmpeg = undefined
    this.analyzer = new SpectrumAnalyzer(offset)
    this.ffmpegError = ''
    const ffmpegArgs = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      ...(offset > 0 ? ['-ss', String(offset)] : []),
      '-re',
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
      this.ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      await this.stopInternal()
      throw new AppError('FFMPEG_START_FAILED', '无法启动 FFmpeg', String(error))
    }

    this.ffmpeg.stderr.on('data', (chunk) => {
      this.ffmpegError = `${this.ffmpegError}${chunk.toString('utf8')}`.slice(-4000)
    })
    this.ffmpeg.stdout.on('data', (chunk: Buffer) => {
      this.analyzer?.push(chunk)
    })
    this.ffmpeg.once('error', (error) => {
      if (!this.stopping) this.ffmpegError = error.message
    })
    this.ffmpeg.once('close', (code) => {
      if (!this.stopping && code && code !== 0) {
        this.ffmpegError ||= `FFmpeg 频谱分析进程退出：${code}`
      }
    })
  }

  async pause() {
    await this.ipc?.command('set_property', 'pause', true)
    this.ffmpeg?.stdout.removeAllListeners()
    this.ffmpeg?.removeAllListeners()
    this.ffmpeg?.kill()
    this.ffmpeg = undefined
  }

  async resume() {
    if (this.currentUrl && this.currentOptions) {
      await this.startAnalyzer(this.currentUrl, this.currentOptions.ffmpegPath, this.position)
    }
    await this.ipc?.command('set_property', 'pause', false)
  }

  async setVolume(volume: number) {
    await this.ipc?.command('set_property', 'volume', volume)
  }

  seek(position: number) {
    return this.enqueue(async () => {
      if (!this.ipc || !this.currentUrl || !this.currentOptions) {
        throw new AppError('NOT_PLAYING', '当前没有可 Seek 的音频管线')
      }
      await this.ipc.command('seek', position, 'absolute+exact')
      this.position = position
      this.offset = position
      await this.startAnalyzer(this.currentUrl, this.currentOptions.ffmpegPath, position)
    })
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

  stop() {
    return this.enqueue(() => this.stopInternal())
  }

  private async stopInternal() {
    this.stopping = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.ffmpeg?.stdout.removeAllListeners()
    this.ffmpeg?.removeAllListeners('close')
    this.ffmpeg?.removeAllListeners('error')
    this.mpv?.removeAllListeners('close')
    this.mpv?.removeAllListeners('error')
    this.ffmpeg?.kill()
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
    this.currentUrl = ''
    this.currentOptions = undefined
  }
}
