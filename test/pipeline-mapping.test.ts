import { describe, expect, it } from 'vitest'
import { analyzerPositionFor } from '../src/audio/pipeline.js'

describe('analyzerPositionFor', () => {
  it('正常速度下分析器位置与播放位置一致', () => {
    expect(analyzerPositionFor(12, 0, 1)).toBe(12)
    expect(analyzerPositionFor(12, 8, 1)).toBe(12)
  })

  it('倍速时把播放位置压缩回分析器进度', () => {
    // 从 8 秒起以 2x 播放：又过了 4 秒播放位置到达 12，但音频流只前进 2 秒
    expect(analyzerPositionFor(12, 8, 2)).toBeCloseTo(10, 6)
  })

  it('慢速播放时分析器进度落后于播放位置', () => {
    expect(analyzerPositionFor(11, 10, 0.5)).toBeCloseTo(12, 6)
  })

  it('非法倍速或非法位置时退回原值', () => {
    expect(analyzerPositionFor(5, 0, 0)).toBe(5)
    expect(analyzerPositionFor(5, 0, Number.NaN)).toBe(5)
    expect(analyzerPositionFor(Number.NaN, 0, 2)).toBe(Number.NaN)
  })
})
