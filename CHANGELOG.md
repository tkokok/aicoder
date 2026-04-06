# Changelog

## [2.2.5] - 2026-04-06

### Added
- Release assets now include `README.md` and `start.sh` for easier deployment.
- Release assets now include `.env.example` so users can configure the server out of the box.

## [2.2.4] - 2026-04-06

### Changed
- Release builds now use a dedicated `tsconfig.release.json` with `sourceMap: false`, producing smaller and cleaner release assets.
- GitHub Actions release workflow updated to use `bun run build:release` instead of stripping maps after build.

## [2.2.3] - 2026-04-04

### Fixed
- Data plane now always starts alongside control plane (removed obsolete `MODE=local` guard).
- Fixed P0 auto-complete bug caused by literal `"finish"`/`"stop"` string matching in playbook instructions.
- Filesystem watcher reconnect: existing `*.json` stage files are now processed on `watchPipeline` startup.
- Reattach after control plane restart preserves original pipeline mode from checkpoint instead of defaulting to `standard`.

### Added
- New E2E integration test suite (`tests/e2e-integration.test.ts`) covering health, agent/models, pipeline completion, reconnect, and callback loops.
- GitHub Actions release workflow for automated builds and asset packaging on tag push.
