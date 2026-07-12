import { AppError } from './errors.js'

export const normalizeNeteaseCookie = (input: string) => {
  let raw = input.trim().replace(/^cookie\s*:\s*/i, '')
  if (!raw) throw new AppError('COOKIE_REQUIRED', 'Cookie 不能为空')

  if (!raw.includes('=')) raw = `MUSIC_U=${raw}`

  const values = new Map<string, { name: string; value: string }>()
  for (const part of raw.split(/[;\r\n]+/)) {
    const item = part.trim()
    if (!item) continue
    const separator = item.indexOf('=')
    if (separator <= 0) continue
    const name = item.slice(0, separator).trim()
    const value = item.slice(separator + 1).trim()
    if (!name || !value) continue
    values.set(name.toUpperCase(), { name, value })
  }

  const musicU = values.get('MUSIC_U')
  if (!musicU?.value) {
    throw new AppError('COOKIE_MUSIC_U_REQUIRED', 'Cookie 中缺少有效的 MUSIC_U')
  }
  if (!values.has('OS')) values.set('OS', { name: 'os', value: 'pc' })

  return [...values.values()].map(({ name, value }) => `${name}=${value}`).join('; ')
}
