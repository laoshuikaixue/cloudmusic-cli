import { createRequire } from 'node:module'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCloudUpload } from '../src/core/cloud-upload.js'
import { NeteaseApi } from '../src/api/netease.js'

// A small valid PCM WAV, requiring no external tool or network for tests.
const wav = () => {
  const data = Buffer.alloc(44 + 1600)
  data.write('RIFF')
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(8000, 24)
  data.writeUInt32LE(16000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(1600, 40)
  return data
}
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ncm-upload-test-'))
  directories.push(directory)
  const file = join(directory, '英语学习.wav')
  await writeFile(file, wav())
  return file
}
const apiWith = (
  call: (
    name: string,
    params: any,
    auth?: { cookie: string; requireCurrentCookie?: boolean },
  ) => Promise<any>,
  cookie = 'MUSIC_U=test',
) => {
  const api = Object.create(NeteaseApi.prototype) as NeteaseApi
  Object.assign(api, { getCookie: () => cookie, call })
  return api
}
const cloud = (rows: any[]) => ({ code: 200, data: rows, size: 0, maxSize: 1_000_000 })

describe('cloud upload', () => {
  it('prepares offline, preserves source and applies a Chinese filename fallback', async () => {
    const file = await fixture()
    const before = await readFile(file)
    const { plan } = await prepareCloudUpload({ file, name: '英语学习_测试.wav', dryRun: true })
    expect(plan).toMatchObject({ mode: 'dry-run', title: '英语学习_测试', sourceUnchanged: true })
    expect(plan.md5).toMatch(/^[a-f0-9]{32}$/)
    expect(await readFile(file)).toEqual(before)
  })
  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
    'preserves tagged title unless explicitly replaced; title remux preserves decoded audio and source',
    async () => {
      const originalWav = await fixture()
      const file = join(originalWav, '..', 'tagged.mp3')
      const run = promisify(execFile)
      await run('ffmpeg', [
        '-v',
        'error',
        '-n',
        '-i',
        originalWav,
        '-metadata',
        'title=Existing title',
        file,
      ])
      const original = await readFile(file)
      const ordinary = await prepareCloudUpload({ file, name: '英语学习_new.mp3' })
      expect(ordinary.plan.title).toBe('Existing title')
      const prepared = await prepareCloudUpload({ file, title: '英语学习_新标题' })
      expect(prepared.plan.title).toBe('英语学习_新标题')
      expect(await readFile(file)).toEqual(original)
      const tagged = join(file, '..', 'prepared.mp3')
      await writeFile(tagged, prepared.data)
      const pcm = async (path: string) => {
        const { stdout } = await run(
          'ffmpeg',
          [
            '-v',
            'error',
            '-i',
            path,
            '-map',
            '0:a:0',
            '-f',
            's16le',
            '-c:a',
            'pcm_s16le',
            'pipe:1',
          ],
          { encoding: 'buffer' },
        )
        return createHash('sha256').update(stdout).digest('hex')
      }
      expect(await pcm(tagged)).toBe(await pcm(file))
    },
  )
  it('dry-run needs no cookie and never calls the API', async () => {
    const call = vi.fn()
    const api = apiWith(call, '')
    expect(await api.uploadCloud({ file: await fixture(), dryRun: true })).toMatchObject({
      networkCalled: false,
      authenticationRead: false,
    })
    expect(call).not.toHaveBeenCalled()
  })
  it('rejects unsafe names, bad audio and unsupported title rewrites', async () => {
    const file = await fixture()
    await expect(prepareCloudUpload({ file, name: '../a.wav' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(prepareCloudUpload({ file, title: 'test' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await writeFile(file, 'not audio')
    await expect(prepareCloudUpload({ file })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
  it('requires authentication before any remote request', async () => {
    const call = vi.fn()
    const api = apiWith(call, '')
    await expect(api.uploadCloud({ file: await fixture() })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
    expect(call).not.toHaveBeenCalled()
  })
  it('encodes filename for upstream, uploads Buffer without tempFilePath, verifies IDs and suppresses secrets', async () => {
    const file = await fixture()
    let uploaded = false
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const call = vi.fn(async (name, params) => {
      if (name === 'login_status') return { data: { code: 200, profile: { userId: 1 } } }
      if (name === 'user_cloud')
        return cloud(
          uploaded ? [{ songId: 123, songName: '英语学习', simpleSong: { id: 456 } }] : [],
        )
      expect(name).toBe('cloud')
      console.error({ cookie: 'secret-cookie', token: 'secret-token' })
      expect(Buffer.from(params.songFile.name, 'latin1').toString('utf8')).toBe('英语学习.wav')
      expect(Buffer.isBuffer(params.songFile.data)).toBe(true)
      expect(params.songFile.tempFilePath).toBeUndefined()
      uploaded = true
      return { code: 200, privateCloud: { songId: 123 } }
    })
    expect(await apiWith(call).uploadCloud({ file })).toMatchObject({
      songId: 123,
      trackId: 456,
      verified: true,
      repeated: false,
    })
    expect(stderr).not.toHaveBeenCalled()
    expect(await readFile(file)).toEqual(wav())
  })
  it('skips only MD5-confirmed entries, never title-only matches', async () => {
    const file = await fixture()
    const { plan } = await prepareCloudUpload({ file })
    const call = vi.fn(async (name) =>
      name === 'login_status'
        ? { code: 200, profile: { userId: 1 } }
        : cloud([{ md5: plan.md5, songId: 9, songName: plan.title }]),
    )
    expect(await apiWith(call).uploadCloud({ file })).toMatchObject({ songId: 9, repeated: true })
    expect(call.mock.calls.map(([name]) => name)).toEqual(['login_status', 'user_cloud'])
  })
  it('rejects overlapping uploads and releases its gate after failure', async () => {
    const file = await fixture()
    const api = apiWith(async () => {
      throw new Error('failed')
    })
    const first = api.uploadCloud({ file })
    await expect(api.uploadCloud({ file })).rejects.toMatchObject({ code: 'CLOUD_UPLOAD_BUSY' })
    await expect(first).rejects.toMatchObject({ code: 'CLOUD_REQUEST_FAILED' })
    expect(await api.uploadCloud({ file, dryRun: true })).toMatchObject({ mode: 'dry-run' })
  })
  it('stops before upload if authentication changes after preflight', async () => {
    let cookie = 'MUSIC_U=account-a'
    const call = vi.fn(async (name) => {
      if (name === 'login_status') return { code: 200, profile: { userId: 1 } }
      cookie = 'MUSIC_U=account-b'
      return cloud([])
    })
    const api = apiWith(call)
    Object.assign(api, { getCookie: () => cookie })
    await expect(api.uploadCloud({ file: await fixture() })).rejects.toMatchObject({
      code: 'AUTH_CHANGED',
      details: undefined,
    })
    expect(call.mock.calls.map(([name]) => name)).toEqual(['login_status', 'user_cloud'])
  })
  it('pins every upload and readback request to the authentication snapshot', async () => {
    let cookie = 'MUSIC_U=account-a'
    let uploaded = false
    const call = vi.fn(async (name, _params, auth) => {
      expect(auth?.cookie).toBe('MUSIC_U=account-a')
      if (name === 'login_status') return { code: 200, profile: { userId: 1 } }
      if (name === 'cloud') {
        expect(auth?.requireCurrentCookie).toBe(true)
        cookie = 'MUSIC_U=account-b'
        uploaded = true
        return { code: 200, songId: 17 }
      }
      return cloud(uploaded ? [{ songId: 17, songName: '英语学习' }] : [])
    })
    const api = apiWith(call)
    Object.assign(api, { getCookie: () => cookie })
    expect(await api.uploadCloud({ file: await fixture() })).toMatchObject({
      songId: 17,
      verified: true,
    })
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      'login_status',
      'user_cloud',
      'cloud',
      'user_cloud',
    ])
  })
  it('internal requests honor auth override and recheck mutation auth after initialization', async () => {
    const upstream = createRequire(import.meta.url)('@neteasecloudmusicapienhanced/api')
    const fn = vi.spyOn(upstream, 'cloud').mockResolvedValue({ body: { code: 200 } })
    let cookie = 'MUSIC_U=account-b'
    const api = new NeteaseApi(() => cookie)
    const initialize = vi.spyOn(api, 'initialize').mockResolvedValue(undefined)
    const call = (
      api as unknown as {
        call: (
          name: string,
          params: Record<string, unknown>,
          auth: { cookie: string; requireCurrentCookie?: boolean },
        ) => Promise<unknown>
      }
    ).call.bind(api)
    await call('cloud', {}, { cookie: 'MUSIC_U=account-a' })
    expect(fn).toHaveBeenCalledWith({ cookie: 'MUSIC_U=account-a' })
    fn.mockClear()
    cookie = 'MUSIC_U=account-a'
    initialize.mockImplementation(async () => {
      cookie = 'MUSIC_U=account-b'
    })
    await expect(
      call('cloud', {}, { cookie: 'MUSIC_U=account-a', requireCurrentCookie: true }),
    ).rejects.toMatchObject({ code: 'AUTH_CHANGED' })
    expect(fn).not.toHaveBeenCalled()
  })
  it('stops on a same-name entry without proof of matching bytes', async () => {
    const file = await fixture()
    const call = vi.fn(async (name) =>
      name === 'login_status'
        ? { code: 200, profile: { userId: 1 } }
        : cloud([{ songId: 9, songName: '英语学习', fileName: '英语学习.wav' }]),
    )
    await expect(apiWith(call).uploadCloud({ file })).rejects.toMatchObject({
      code: 'CLOUD_EXISTING_UNVERIFIABLE',
    })
    expect(call.mock.calls.map(([name]) => name)).not.toContain('cloud')
  })
  it('discards upstream errors and does not leak credential details', async () => {
    const api = apiWith(async () => {
      throw new Error('cookie=secret token=secret https://example.test/signed')
    })
    await expect(api.uploadCloud({ file: await fixture() })).rejects.toMatchObject({
      code: 'CLOUD_REQUEST_FAILED',
      details: undefined,
    })
  })
  it('rejects insufficient capacity before upload', async () => {
    const call = vi.fn(async (name) =>
      name === 'login_status'
        ? { code: 200, profile: { userId: 1 } }
        : { ...cloud([]), maxSize: 1 },
    )
    await expect(apiWith(call).uploadCloud({ file: await fixture() })).rejects.toMatchObject({
      code: 'CLOUD_CAPACITY_INSUFFICIENT',
    })
    expect(call.mock.calls.map(([name]) => name)).not.toContain('cloud')
  })
  it('rejects business failure rather than reporting upload success', async () => {
    const api = apiWith(async (name) =>
      name === 'login_status'
        ? { code: 200, profile: { userId: 1 } }
        : name === 'cloud'
          ? { code: 500, songId: 17, token: 'secret' }
          : cloud([]),
    )
    await expect(api.uploadCloud({ file: await fixture() })).rejects.toMatchObject({
      code: 'CLOUD_REQUEST_FAILED',
      details: undefined,
    })
  })
  it.each([
    'remote-error',
    'invalid-list',
    'pagination-limit',
    'invalid-track-id',
    'title-mismatch',
  ])('retains only the known songId after upload when readback encounters %s', async (failure) => {
    let uploaded = false
    const api = apiWith(async (name) => {
      if (name === 'login_status') return { code: 200, profile: { userId: 1 } }
      if (name === 'cloud') {
        uploaded = true
        return { code: 200, songId: 17 }
      }
      if (!uploaded) return cloud([])
      if (failure === 'remote-error')
        throw new Error('cookie=secret token=secret https://example.test/signed')
      if (failure === 'invalid-list') return { ...cloud([]), data: { token: 'secret' } }
      if (failure === 'pagination-limit') return { ...cloud([]), hasMore: true }
      if (failure === 'invalid-track-id')
        return cloud([{ songId: 17, simpleSong: { id: 'invalid' }, songName: '英语学习' }])
      return cloud([{ songId: 17, songName: 'unexpected title' }])
    })
    const error = await api.uploadCloud({ file: await fixture() }).then(
      () => {
        throw new Error('expected rejection')
      },
      (failure: unknown) => failure,
    )
    expect(error).toMatchObject({
      code: failure === 'title-mismatch' ? 'CLOUD_TITLE_MISMATCH' : 'CLOUD_READBACK_FAILED',
      details: { songId: 17 },
    })
    expect(JSON.stringify(error)).not.toContain('secret')
    expect((error as Error).message).not.toContain('secret')
    expect((error as { details: unknown }).details).toEqual({ songId: 17 })
  })
  it('reports an upload that cannot be confirmed by ID as a partial failure', async () => {
    const api = apiWith(async (name) =>
      name === 'login_status'
        ? { code: 200, profile: { userId: 1 } }
        : name === 'cloud'
          ? { code: 200, songId: 17 }
          : cloud([]),
    )
    await expect(api.uploadCloud({ file: await fixture() })).rejects.toMatchObject({
      code: 'CLOUD_READBACK_FAILED',
      details: { songId: 17 },
    })
  })
})
