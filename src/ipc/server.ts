import { createServer, type Socket } from 'node:net'
import { mkdir, unlink } from 'node:fs/promises'
import { paths } from '../core/paths.js'
import { toAppError } from '../core/errors.js'
import type { RpcRequest, RpcResponse } from '../core/types.js'
import { PlayerDaemon } from '../daemon/player-daemon.js'

export const runDaemonServer = async () => {
  await mkdir(paths.dataDir, { recursive: true })
  await mkdir(paths.logDir, { recursive: true })
  if (process.platform !== 'win32') await unlink(paths.daemonSocket).catch(() => undefined)
  const daemon = new PlayerDaemon()
  await daemon.initialize()
  const subscribers = new Set<Socket>()

  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        void (async () => {
          let request: RpcRequest
          try {
            request = JSON.parse(line) as RpcRequest
          } catch {
            return
          }
          if (request.method === 'subscribe') subscribers.add(socket)
          try {
            const result =
              request.method === 'subscribe'
                ? { subscribed: true }
                : await daemon.dispatch(request.method, request.params)
            const response: RpcResponse = { id: request.id, ok: true, result }
            socket.write(`${JSON.stringify(response)}\n`)
            if (request.method === 'shutdown') {
              setTimeout(() => void close(), 20)
            }
          } catch (error) {
            const appError = toAppError(error)
            const response: RpcResponse = {
              id: request.id,
              ok: false,
              error: { code: appError.code, message: appError.message, details: appError.details },
            }
            socket.write(`${JSON.stringify(response)}\n`)
          }
        })()
      }
    })
    socket.on('close', () => subscribers.delete(socket))
    socket.on('error', () => subscribers.delete(socket))
  })

  const eventTimer = setInterval(() => {
    if (!subscribers.size) return
    const status = JSON.stringify({ event: 'status', data: daemon.status() })
    for (const socket of subscribers) {
      socket.write(`${status}\n`)
      void Promise.resolve(daemon.dispatch('spectrum')).then((data) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify({ event: 'spectrum', data })}\n`)
      })
    }
  }, 100)

  const close = async () => {
    clearInterval(eventTimer)
    await daemon.shutdown()
    for (const socket of subscribers) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') await unlink(paths.daemonSocket).catch(() => undefined)
    process.exit(0)
  }

  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(paths.daemonSocket, () => resolve())
  })
}
