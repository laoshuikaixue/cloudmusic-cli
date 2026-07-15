export interface PlayerLayout {
  expanded: boolean
  height?: number
  progressWidth: number
  spectrumWidth: number
}

export interface ProgressBarSegments {
  completedCells: number
  hasTransition: boolean
  transitionIntensity: number
  remainingCells: number
}

export const renderProgressBar = (progress: number, width: number): ProgressBarSegments => {
  const safeWidth = Math.max(0, Math.floor(width))
  const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0
  const exactPosition = safeProgress * safeWidth
  const completedCells = Math.min(safeWidth, Math.floor(exactPosition))
  const hasTransition = safeProgress > 0 && completedCells < safeWidth
  const transitionProgress = exactPosition - completedCells
  const transitionIntensity =
    transitionProgress <= 0 || transitionProgress >= 1
      ? transitionProgress
      : -(Math.cos(Math.PI * transitionProgress) - 1) / 2
  const remainingCells = Math.max(0, safeWidth - completedCells - (hasTransition ? 1 : 0))

  return {
    completedCells,
    hasTransition,
    transitionIntensity,
    remainingCells,
  }
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
