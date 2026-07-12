# CloudMusic CLI Agent Instructions

- Use `pnpm` only. Node.js 22 or later is required.
- Keep CLI stdout machine-readable when `--json` or `--jsonl` is active; diagnostics belong on stderr.
- Never print cookies, signed playback URLs, tokens, or local IPC authentication material.
- Preserve the daemon/client boundary: CLI, TUI, and MCP clients must not own playback state.
- Frequency visualizations must be based on decoded PCM, not random or decorative values.
- Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before delivery.
- The project is AGPL-3.0-only. Retain attribution for code adapted from SPlayer.
