# Changelog

## [2.2.3] - 2026-04-04

### Fixed
- Data plane now always starts alongside control plane (removed obsolete `MODE=local` guard).
- Fixed P0 auto-complete bug caused by literal `"finish"`/`"stop"` string matching in playbook instructions.
- Filesystem watcher reconnect: existing `*.json` stage files are now processed on `watchPipeline` startup.
- Reattach after control plane restart preserves original pipeline mode from checkpoint instead of defaulting to `standard`.

### Added
- New E2E integration test suite (`tests/e2e-integration.test.ts`) covering health, agent/models, pipeline completion, reconnect, and callback loops.
- GitHub Actions release workflow for automated builds and asset packaging on tag push.
