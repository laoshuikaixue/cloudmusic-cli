export interface PlayerLayout {
  expanded: boolean
  height?: number
  mainGap: number
  progressWidth: number
  spectrumWidth: number
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value))

export const getPlayerLayout = (columns: number, rows: number): PlayerLayout => {
  const safeColumns = Math.max(40, columns)
  const safeRows = Math.max(16, rows)
  const expanded = safeRows >= 32
  return {
    expanded,
    height: expanded ? safeRows : undefined,
    mainGap: expanded ? clamp(Math.floor((safeRows - 26) / 4), 2, 6) : 0,
    progressWidth: Math.max(10, safeColumns - 30),
    spectrumWidth: Math.max(12, safeColumns - 8),
  }
}
