# Changelog

## v0.1.0 - 2026-06-10

### Added

- Added the Dynamic Workflows Codex plugin with a local workflow planner, approval-gated runner, resumable run state, cancellation, append-only events, and schema validation.
- Added CLI and MCP entrypoints for planning, running, approving, resuming, cancelling, inspecting, and validating workflow runs.
- Added tests for core workflow state transitions, CLI JSON output, plugin layout validation, MCP tool behavior, and Codex newline-delimited JSON framing.

### Changed

- Store ccdw-managed local state under `.ccdw/` by default instead of `docs/local`.
- Added `CCDW_HOME` support for relocating ccdw-managed local state, with explicit `runRoot` and `--run-root` values taking precedence.
- Removed Japanese response language policy from the ccdw project instructions.
