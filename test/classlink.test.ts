import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { ClassLinkBridge, serializeClassLinkLyrics } from '../src/system/classlink.js'

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('等待 ClassLink 请求超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('ClassLink lyric serialization', () => {
  it('converts seconds to milliseconds and preserves advanced lyric fields', () => {
    const result = serializeClassLinkLyrics({
      format: 'ttml',
      source: 'amll',
      upgraded: true,
      lines: [
        {
          time: 1.25,
          endTime: 3.5,
          text: 'Hello world',
          translation: '你好世界',
          romanization: 'hello world',
          isBackground: true,
          isDuet: true,
          words: [
            { startTime: 1.25, endTime: 2, text: 'Hello ' },
            { startTime: 2, endTime: 3.5, text: 'world', romanization: 'world' },
          ],
        },
      ],
    })

    expect(result).toEqual({
      status: 'ready',
      source: 'amll',
      format: 'ttml',
      platform: 'netease',
      lines: [
        {
          words: [
            { startTime: 1250, endTime: 2000, word: 'Hello ', romanWord: undefined },
            { startTime: 2000, endTime: 3500, word: 'world', romanWord: 'world' },
          ],
          translatedLyric: '你好世界',
          romanLyric: 'hello world',
          startTime: 1250,
          endTime: 3500,
          isBG: true,
          isDuet: true,
        },
      ],
    })
  })

  it('creates one timed word for line lyrics without word timing', () => {
    const result = serializeClassLinkLyrics({
      format: 'lrc',
      source: 'netease',
      upgraded: false,
      lines: [{ time: 4, endTime: 8, text: '整行歌词' }],
    })

    expect(result.lines[0]?.words).toEqual([{ startTime: 4000, endTime: 8000, word: '整行歌词' }])
  })

  it('pushes a new full state when background lyric upgrade changes the revision', async () => {
    const states: Array<Record<string, any>> = []
    const authorizations: Array<string | undefined> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        authorizations.push(request.headers.authorization)
        if (request.url === '/v1/state') {
          states.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"message":"ok"}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const bridge = new ClassLinkBridge()
    try {
      bridge.configure({ enabled: true, port }, 'local-test-token')
      bridge.sync({
        song: null,
        trackRevision: 1,
        lyricRevision: 1,
        lyrics: { format: 'lrc', source: 'netease', upgraded: false, lines: [] },
        state: 'paused',
        positionMs: 0,
      })
      await waitFor(() => states.length >= 1)

      bridge.sync({
        song: null,
        trackRevision: 1,
        lyricRevision: 2,
        lyrics: {
          format: 'ttml',
          source: 'amll',
          upgraded: true,
          lines: [{ time: 1, endTime: 2, text: '升级歌词', isBackground: true }],
        },
        state: 'paused',
        positionMs: 500,
      })
      await waitFor(() => states.length >= 2)

      expect(states.at(-1)?.lyrics).toMatchObject({
        format: 'ttml',
        revision: 2,
        lines: [{ isBG: true }],
      })
      expect(states.at(-1)?.stateRevision).toBeGreaterThan(states[0]?.stateRevision)
      expect(authorizations.every((value) => value === 'Bearer local-test-token')).toBe(true)
    } finally {
      bridge.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('resends the current cover when the receiver reports that it is missing', async () => {
    const cover = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    let coverUploads = 0
    let coverDownloads = 0
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/cover.jpg')) {
        coverDownloads += 1
        response.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(cover.length),
        })
        response.end(cover)
        return
      }

      request.resume()
      request.on('end', () => {
        if (request.url?.startsWith('/v1/cover?')) coverUploads += 1
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          request.url === '/v1/state'
            ? '{"message":"ok","coverRequired":true}'
            : '{"message":"ok"}',
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const song = {
      id: 1,
      name: 'Song',
      artists: [{ id: 1, name: 'Artist' }],
      album: { id: 1, name: 'Album', cover: `http://127.0.0.1:${port}/cover.jpg` },
      duration: 180000,
    }
    const bridge = new ClassLinkBridge()
    try {
      bridge.configure({ enabled: true, port }, 'local-test-token')
      bridge.sync({
        song,
        trackRevision: 1,
        lyricRevision: 1,
        lyrics: { format: 'lrc', source: 'netease', upgraded: false, lines: [] },
        state: 'playing',
        positionMs: 1000,
      })
      await waitFor(() => coverUploads >= 1)

      bridge.sync({
        song,
        trackRevision: 1,
        lyricRevision: 2,
        lyrics: {
          format: 'lrc',
          source: 'netease',
          upgraded: false,
          lines: [{ time: 1, endTime: 2, text: 'line' }],
        },
        state: 'playing',
        positionMs: 2000,
      })
      await waitFor(() => coverUploads >= 2)

      expect(coverUploads).toBe(2)
      expect(coverDownloads).toBe(1)
    } finally {
      bridge.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
