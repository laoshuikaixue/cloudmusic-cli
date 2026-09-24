import type { SleepStatus, SleepTimerMode } from '../core/types.js'

export const MIN_SLEEP_MINUTES = 1
export const MAX_SLEEP_MINUTES = 24 * 60

export interface SleepTimer {
  mode: SleepTimerMode
  endsAt?: number
}

export const timerSleep = (minutes: number, now: number): SleepTimer | null => {
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return { mode: 'timer', endsAt: now + Math.round(minutes * 60_000) }
}

export const songEndSleep = (): SleepTimer => ({ mode: 'song-end' })

export const sleepStatusOf = (
  timer: SleepTimer | undefined,
  now: number,
): SleepStatus | undefined => {
  if (!timer) return undefined
  if (timer.mode === 'song-end') return { mode: 'song-end' }
  const remaining = (timer.endsAt ?? 0) - now
  return {
    mode: 'timer',
    endsAt: timer.endsAt,
    remainingSeconds: Math.max(0, Math.ceil(remaining / 1000)),
  }
}

export const sleepTimerExpired = (timer: SleepTimer | undefined, now: number) =>
  timer?.mode === 'timer' && (timer.endsAt ?? 0) <= now

/** 把剩余秒数格式化成 25:00 / 1:05:09 */
export const formatSleepRemaining = (remainingSeconds: number) => {
  const total = Math.max(0, Math.floor(remainingSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}
