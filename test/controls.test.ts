import { describe, expect, it } from 'vitest'
import { normalizeControlInput } from '../src/tui/controls.js'

describe('normalizeControlInput', () => {
  it('treats upper- and lowercase letter controls equally', () => {
    expect(normalizeControlInput('N')).toBe('n')
    expect(normalizeControlInput('n')).toBe('n')
    expect(normalizeControlInput('F')).toBe('f')
  })

  it('preserves non-letter controls', () => {
    expect(normalizeControlInput('/')).toBe('/')
    expect(normalizeControlInput(' ')).toBe(' ')
  })
})
