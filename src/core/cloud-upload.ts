import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { parseBuffer } from 'music-metadata'
import { AppError } from './errors.js'

export interface CloudUploadOptions {
  file: string
  name?: string
  title?: string
  dryRun?: boolean
  ffmpegPath?: string
}

const maxBytes = 200 * 1024 * 1024
const mimeTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
}
const hash = (data: Buffer, algorithm: string) => createHash(algorithm).update(data).digest('hex')
const hasControl = (text: string) => [...text].some((character) => character.charCodeAt(0) < 32)
const invalid = (message: string) => new AppError('INVALID_ARGUMENT', message)

/** All preparation is local. Never expose buffers or pass a source path to the upstream API. */
export async function prepareCloudUpload(options: CloudUploadOptions) {
  if (typeof options.file !== 'string' || !options.file.trim()) throw invalid('file 不能为空')
  const file = resolve(options.file)
  const extension = extname(file).toLowerCase()
  const mimetype = mimeTypes[extension]
  if (!mimetype) throw invalid('支持 mp3、flac、wav、m4a、ogg 音频')
  const info = await stat(file).catch(() => {
    throw invalid('无法读取音频文件')
  })
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes)
    throw invalid('音频必须是非空文件且不超过 200 MiB')
  const name = options.name ?? basename(file)
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    /[/\\]/.test(name) ||
    hasControl(name) ||
    name.length > 255 ||
    extname(name).toLowerCase() !== extension
  ) {
    throw invalid('name 必须是保留原扩展名的文件名，不能包含路径或控制字符')
  }
  if (
    options.title !== undefined &&
    (typeof options.title !== 'string' ||
      !options.title.trim() ||
      hasControl(options.title) ||
      options.title.length > 255)
  )
    throw invalid('title 必须是非空名称且不包含控制字符')
  if (options.title !== undefined && extension !== '.mp3')
    throw invalid('--title 暂仅支持 MP3；其他格式请预先设置音频标签')
  const source = await readFile(file)
  let data = source
  if (options.title !== undefined) {
    const directory = await mkdtemp(join(tmpdir(), 'ncm-upload-'))
    try {
      const copy = join(directory, 'tagged.mp3')
      await promisify(execFile)(
        options.ffmpegPath ?? 'ffmpeg',
        [
          '-v',
          'error',
          '-n',
          '-i',
          file,
          '-map',
          '0:a:0',
          '-c:a',
          'copy',
          '-map_metadata',
          '0',
          '-id3v2_version',
          '3',
          '-metadata',
          `title=${options.title}`,
          copy,
        ],
        { timeout: 120_000 },
      )
      data = await readFile(copy)
    } catch {
      throw new AppError('AUDIO_PREPARATION_FAILED', '无法设置 MP3 title，请检查 FFmpeg 与音频文件')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  const metadata = await parseBuffer(data, { mimeType: mimetype }, { duration: true }).catch(() => {
    throw invalid('无法解析音频文件')
  })
  if (!metadata.format.codec || !(Number(metadata.format.duration) > 0))
    throw invalid('文件没有可识别的音频或时长')
  if (options.title !== undefined && metadata.common.title !== options.title)
    throw new AppError('AUDIO_TAG_MISMATCH', 'MP3 title 标签校验失败')
  if (data.length > maxBytes) throw invalid('准备后的音频超过 200 MiB')
  const sourceSha256 = hash(source, 'sha256')
  if (hash(await readFile(file), 'sha256') !== sourceSha256)
    throw new AppError('SOURCE_CHANGED', '准备期间原文件发生变化，请重试')
  return {
    data,
    plan: {
      mode: options.dryRun ? 'dry-run' : 'upload',
      file,
      name,
      title:
        metadata.common.title ||
        name
          .replace(/\.[^.]+$/, '')
          .replace(/\s/g, '')
          .replace(/\./g, '_'),
      size: data.length,
      sourceSha256,
      sha256: hash(data, 'sha256'),
      md5: hash(data, 'md5'),
      mimetype,
      sourceUnchanged: true,
      authenticationRequired: true,
    },
  }
}
