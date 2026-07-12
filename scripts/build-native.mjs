import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'win32') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = join(root, 'native', 'smtc', 'Cargo.toml')
const result = spawnSync('cargo', ['build', '--release', '--manifest-path', manifest], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})
if (result.status !== 0) process.exit(result.status || 1)

const source = join(root, 'native', 'smtc', 'target', 'release', 'cloudmusic-smtc.exe')
const destination = join(root, 'dist', 'native', 'cloudmusic-smtc.exe')
await mkdir(dirname(destination), { recursive: true })
try {
  await copyFile(source, destination)
} catch (error) {
  if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error
  console.warn('SMTC 正在运行，保留现有 dist/native 桥接器；停止 daemon 后可重新构建以更新它。')
}
