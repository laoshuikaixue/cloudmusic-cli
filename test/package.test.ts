import { describe, expect, it } from 'vitest'
import packageMetadata from '../package.json' with { type: 'json' }

describe('npm package entry points', () => {
  it('exposes an explicit executable for npx and the short ncm alias', () => {
    expect(packageMetadata.bin).toEqual({
      'cloudmusic-cli': 'dist/cli.js',
      ncm: 'dist/cli.js',
    })
    expect(packageMetadata.files).toContain('dist')
  })
})
