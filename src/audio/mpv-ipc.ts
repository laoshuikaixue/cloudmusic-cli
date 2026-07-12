import { createConnection, type Socket } from 'node:net'
import { AppError } from '../core/errors.js'

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export class MpvIpc {
  private socket?: Socket
  private requestId = 0
  private buffer = ''
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(private readonly socketPath: string) {}

  async connect(timeout = 5000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        await this.connectOnce()
        return
      } catch {
        await delay(80)
      }
    }
    throw new AppError('MPV_IPC_FAILED', '无法连接 mpv 控制通道')
  }

  private connectOnce() {
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      const onError = (error: Error) => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.on('error', () => this.rejectAll(new Error('mpv IPC 已断开')))
        socket.on('data', (chunk) => this.onData(chunk.toString('utf8')))
        socket.on('close', () => this.rejectAll(new Error('mpv IPC 已关闭')))
        this.socket = socket
        resolve()
      })
    })
  }

  private onData(chunk: string) {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        const request = this.pending.get(message.request_id)
        if (!request) continue
        this.pending.delete(message.request_id)
        if (message.error && message.error !== 'success') {
          request.reject(new Error(message.error))
        } else {
          request.resolve(message.data)
        }
      } catch {
        // 忽略 mpv 的非 JSON 输出。
      }
    }
  }

  command<T = unknown>(...command: unknown[]): Promise<T> {
    if (!this.socket) return Promise.reject(new Error('mpv IPC 尚未连接'))
    const requestId = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.socket?.write(`${JSON.stringify({ command, request_id: requestId })}\n`)
    })
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  close() {
    this.socket?.destroy()
    this.socket = undefined
    this.rejectAll(new Error('mpv IPC 已关闭'))
  }
}
