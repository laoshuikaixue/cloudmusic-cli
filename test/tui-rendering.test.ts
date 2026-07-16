import { describe, expect, it } from 'vitest'
import {
  canRenderTerminalFrame,
  TUI_FRAME_INTERVAL_MS,
  TUI_INCREMENTAL_RENDERING,
  TUI_MAX_FPS,
} from '../src/tui/rendering.js'

describe('TUI rendering pressure control', () => {
  it('uses one bounded animation cadence', () => {
    expect(TUI_MAX_FPS).toBe(20)
    expect(TUI_FRAME_INTERVAL_MS).toBe(50)
  })

  it('keeps Ink incremental rendering disabled for Windows terminal compatibility', () => {
    expect(TUI_INCREMENTAL_RENDERING).toBe(false)
  })

  it('pauses replaceable frames while stdout is backpressured', () => {
    expect(canRenderTerminalFrame({ writableNeedDrain: false })).toBe(true)
    expect(canRenderTerminalFrame({ writableNeedDrain: true })).toBe(false)
  })
})
