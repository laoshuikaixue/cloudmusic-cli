import { describe, expect, it } from 'vitest'
import { normalizeNeteaseCookie } from '../src/core/cookie.js'

describe('normalizeNeteaseCookie', () => {
  it('accepts a Cookie header and adds the pc platform', () => {
    expect(normalizeNeteaseCookie('Cookie: MUSIC_U=token; __csrf=value')).toBe(
      'MUSIC_U=token; __csrf=value; os=pc',
    )
  })

  it('accepts a bare MUSIC_U token', () => {
    expect(normalizeNeteaseCookie('token-value')).toBe('MUSIC_U=token-value; os=pc')
  })

  it('rejects cookies without MUSIC_U', () => {
    expect(() => normalizeNeteaseCookie('__csrf=value')).toThrow('MUSIC_U')
  })
})
