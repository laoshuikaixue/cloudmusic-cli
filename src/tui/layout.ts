export interface PlayerLayout {
  expanded: boolean
  height?: number
  progressWidth: number
  spectrumWidth: number
}

export const getPlayerLayout = (columns: number, rows: number): PlayerLayout => {
  const safeColumns = Math.max(40, columns)
  const safeRows = Math.max(16, rows)
  const expanded = safeRows >= 32
  return {
    expanded,
    height: expanded ? safeRows : undefined,
    progressWidth: Math.max(10, safeColumns - 30),
    spectrumWidth: Math.max(12, safeColumns - 8),
  }
}
