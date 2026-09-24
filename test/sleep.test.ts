import { describe, expect, it } from 'vitest'
import {
  formatSleepRemaining,
  sleepStatusOf,
  sleepTimerExpired,
  songEndSleep,
  timerSleep,
} from '../src/daemon/sleep.js'

const BASE = 1_800_000_000_000

describe('timerSleep', () => {
  it('按分钟数换算到点时间', () => {
    expect(timerSleep(30, BASE)).toEqual({ mode: 'timer', endsAt: BASE + 30 * 60_000 })
  })

  it('非正数不产生定时器', () => {
    expect(timerSleep(0, BASE)).toBeNull()
    expect(timerSleep(-5, BASE)).toBeNull()
    expect(timerSleep(Number.NaN, BASE)).toBeNull()
  })
})

describe('sleepStatusOf', () => {
  it('给出向上取整的剩余秒数', () => {
    const timer = timerSleep(30, BASE)!
    expect(sleepStatusOf(timer, BASE + 1000)).toEqual({
      mode: 'timer',
      endsAt: BASE + 30 * 60_000,
      remainingSeconds: 1799,
    })
  })

  it('到点后剩余秒数不会变成负数', () => {
    const timer = timerSleep(1, BASE)!
    expect(sleepStatusOf(timer, BASE + 120_000)?.remainingSeconds).toBe(0)
  })

  it('播完当前曲模式没有倒计时', () => {
    expect(sleepStatusOf(songEndSleep(), BASE)).toEqual({ mode: 'song-end' })
  })

  it('未设置时返回 undefined', () => {
    expect(sleepStatusOf(undefined, BASE)).toBeUndefined()
  })
})

describe('sleepTimerExpired', () => {
  it('定时器到点为真，song-end 不参与到期判断', () => {
    const timer = timerSleep(1, BASE)!
    expect(sleepTimerExpired(timer, BASE + 59_000)).toBe(false)
    expect(sleepTimerExpired(timer, BASE + 60_000)).toBe(true)
    expect(sleepTimerExpired(songEndSleep(), BASE + 10 * 60_000)).toBe(false)
    expect(sleepTimerExpired(undefined, BASE)).toBe(false)
  })
})

describe('formatSleepRemaining', () => {
  it('不足一小时只显示分秒，超过一小时带小时', () => {
    expect(formatSleepRemaining(0)).toBe('00:00')
    expect(formatSleepRemaining(65)).toBe('01:05')
    expect(formatSleepRemaining(600)).toBe('10:00')
    expect(formatSleepRemaining(3660)).toBe('1:01:00')
  })

  it('负数按 0 处理', () => {
    expect(formatSleepRemaining(-10)).toBe('00:00')
  })
})
