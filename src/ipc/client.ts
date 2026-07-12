import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { AppError } from '../core/errors.js'
import { paths } from '../core/paths.js'
import type { RpcEvent, RpcResponse } from '../core/types.js'

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const recoverableSocketCodes = new Set(['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET'])

export const isDaemonConnectionError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && recoverableSocketCodes.has(code)
}

export const requestDaemon = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeout = 30_000,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = createConnection(paths.daemonSocket)
    let buffer = ''
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      socket.destroy()
      finish(() => reject(new AppError('DAEMON_TIMEOUT', `daemon 调用超时：${method}`)))
    }, timeout)
    socket.setEncoding('utf8')
    socket.once('error', (error) => {
      finish(() => reject(error))
    })
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let response: RpcResponse
        try {
          response = JSON.parse(line) as RpcResponse
        } catch (error) {
          socket.destroy()
          finish(() =>
            reject(new AppError('DAEMON_PROTOCOL_ERROR', 'daemon 返回了无效响应', error)),
          )
          return
        }
        if (response.id !== id) continue
        socket.end()
        if (response.ok) finish(() => resolve(response.result as T))
        else
          finish(() =>
            reject(
              new AppError(
                response.error?.code || 'DAEMON_ERROR',
                response.error?.message || 'daemon 调用失败',
                response.error?.details,
              ),
            ),
          )
      }
    })
  })

const spawnDaemon = () => {
  const entry = process.argv[1]
  if (!entry) throw new AppError('DAEMON_START_FAILED', '无法定位 CLI 入口')
  const args = entry.endsWith('.ts') ? ['--import', 'tsx', entry, '__daemon'] : [entry, '__daemon']
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

let daemonStartPromise: Promise<unknown> | undefined

const startDaemon = async () => {
  try {
    return await requestDaemon('ping', undefined, 1000)
  } catch {
    spawnDaemon()
    let lastError: unknown
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await delay(100)
      try {
        return await requestDaemon('ping', undefined, 1000)
      } catch (error) {
        lastError = error
      }
    }
    throw new AppError(
      'DAEMON_START_FAILED',
      '无法启动播放器 daemon',
      lastError instanceof Error ? lastError.message : String(lastError),
    )
  }
}

export const ensureDaemon = () => {
  if (!daemonStartPromise) {
    daemonStartPromise = startDaemon().finally(() => {
      daemonStartPromise = undefined
    })
  }
  return daemonStartPromise
}

export const requestDaemonResilient = async <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeout?: number,
) => {
  try {
    return await requestDaemon<T>(method, params, timeout)
  } catch (error) {
    if (!isDaemonConnectionError(error)) throw error
    await ensureDaemon()
    return requestDaemon<T>(method, params, timeout)
  }
}

export const subscribeDaemon = async (onEvent: (event: RpcEvent) => void) => {
  await ensureDaemon()
  const socket: Socket = createConnection(paths.daemonSocket)
  let buffer = ''
  const id = randomUUID()
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.event) onEvent(message as RpcEvent)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, method: 'subscribe' })}\n`)
      resolve()
    })
  })
  return () => socket.destroy()
}
