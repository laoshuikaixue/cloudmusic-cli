import { afterEach, describe, expect, it } from 'vitest'
import { SpectrumAnalyzer } from '../src/audio/spectrum.js'

const analyzers: SpectrumAnalyzer[] = []

afterEach(async () => {
  await Promise.all(analyzers.splice(0).map((analyzer) => analyzer.destroy()))
})

describe('SpectrumAnalyzer', () => {
  it('produces non-zero bands for a sine wave', async () => {
    const analyzer = new SpectrumAnalyzer()
    analyzers.push(analyzer)
    const sampleCount = 8192
    const pcm = Buffer.alloc(sampleCount * 2 * 2)
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const value = Math.round(Math.sin((2 * Math.PI * 440 * sample) / 48000) * 28000)
      pcm.writeInt16LE(value, sample * 4)
      pcm.writeInt16LE(value, sample * 4 + 2)
    }
    analyzer.push(pcm)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const frame = analyzer.frameAt(0.1)
    expect(frame.peak).toBeGreaterThan(0.2)
    expect(frame.bins.some((value) => value > 0.2)).toBe(true)
  })

  it('keeps silence near zero', async () => {
    const analyzer = new SpectrumAnalyzer()
    analyzers.push(analyzer)
    analyzer.push(Buffer.alloc(8192 * 4))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(analyzer.frameAt(0.1).peak).toBe(0)
  })
})
