import { readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const distDirectory = resolve('dist')
const entries = await readdir(distDirectory, { withFileTypes: true }).catch((error) => {
  if (error?.code === 'ENOENT') return []
  throw error
})

await Promise.all(
  entries
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')),
    )
    .map((entry) => unlink(resolve(distDirectory, entry.name))),
)
