import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { Song } from '../core/types.js'

const supportedExtensions = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.ape',
  '.wma',
])

const localId = (file: string) => {
  const value = Number.parseInt(
    createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 8),
    16,
  )
  return -(value || 1)
}

const collectFiles = async (input: string): Promise<string[]> => {
  const absolute = resolve(input)
  const info = await stat(absolute)
  if (info.isFile())
    return supportedExtensions.has(extname(absolute).toLowerCase()) ? [absolute] : []
  if (!info.isDirectory()) return []
  const files: string[] = []
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = resolve(absolute, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(path)))
    else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase()))
      files.push(path)
  }
  return files
}

const runFfprobe = (file: string, ffprobePath: string) =>
  new Promise<any>((resolveResult, reject) => {
    const child = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:format_tags=title,artist,album',
        '-of',
        'json',
        file,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `ffprobe 退出：${code}`))
      try {
        resolveResult(JSON.parse(stdout))
      } catch (error) {
        reject(error)
      }
    })
  })

export const probeLocalSong = async (file: string, ffprobePath = 'ffprobe'): Promise<Song> => {
  const absolute = resolve(file)
  const result = await runFfprobe(absolute, ffprobePath)
  const tags = result?.format?.tags || {}
  const artistText = String(tags.artist || '本地音乐')
  const artists = artistText
    .split(/\s*[;/,]\s*/)
    .filter(Boolean)
    .map((name) => ({ name }))
  const extension = extname(absolute)
  return {
    id: localId(absolute),
    name: String(tags.title || basename(absolute, extension)),
    artists: artists.length ? artists : [{ name: '本地音乐' }],
    album: { name: String(tags.album || '本地音乐') },
    duration: Math.max(0, Math.round(Number(result?.format?.duration || 0) * 1000)),
    quality: extension.slice(1).toLowerCase(),
    localPath: absolute,
  }
}

export const scanLocalSongs = async (input: string, ffprobePath = 'ffprobe') => {
  const files = await collectFiles(input)
  const songs: Song[] = []
  const errors: Array<{ file: string; error: string }> = []
  for (const file of files) {
    try {
      songs.push(await probeLocalSong(file, ffprobePath))
    } catch (error) {
      errors.push({ file, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { songs, errors }
}
