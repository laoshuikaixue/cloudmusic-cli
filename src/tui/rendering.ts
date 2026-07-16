export const TUI_MAX_FPS = 20
export const TUI_FRAME_INTERVAL_MS = Math.ceil(1000 / TUI_MAX_FPS)

// Ink's incremental cursor diffing leaves stale full-width/CJK frames in
// Windows Terminal and cmd. Full-frame rendering stays bounded by the FPS and
// stdout backpressure guards below.
export const TUI_INCREMENTAL_RENDERING = false

export const canRenderTerminalFrame = (stdout: Pick<NodeJS.WriteStream, 'writableNeedDrain'>) =>
  !stdout.writableNeedDrain
